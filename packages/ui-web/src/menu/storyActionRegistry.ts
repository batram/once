import { registerSwipeAction } from "@once/app"
import type { StoryListItem } from "../story/StoryListItem"
import { registerKeyCommand } from "../keyboard/commands"

export type StoryActionGroup = "navigation" | "state" | "discovery" | "history" | "advanced"
export type StoryActionSurface = "button" | "menu" | "swipe" | "key"

/**
 * A story action that is not one of the built-in menu entries. Registering
 * one puts it on every surface it names: the ⋮ menu (and the native menus,
 * which read the same descriptors), the swipe lab's choices, and the
 * keybinding editor. The id is the same string on all of them.
 */
export interface RegisteredStoryAction {
  id: string
  label: string
  group: StoryActionGroup
  surfaces: readonly StoryActionSurface[]
  /** Hides the action from the menu for rows it does not apply to. */
  appliesTo(row: StoryListItem): boolean
  run(row: StoryListItem): void | Promise<void>
}

/** The keyboard layer's way of pointing a command at the cursor's row. */
export type StoryActionKeyBinder = (
  id: string,
  run: (row: StoryListItem) => void | Promise<void>
) => unknown

const actions = new Map<string, { action: RegisteredStoryAction; release(): void }>()
let keyBinder: StoryActionKeyBinder | null = null
const pendingKeys: RegisteredStoryAction[] = []

const storyActionCommandId = (id: string): string => `story-action.${id}`

function bindKey(action: RegisteredStoryAction): () => void {
  const unregisterCommand = registerKeyCommand({
    id: storyActionCommandId(action.id),
    label: action.label,
    group: "actions",
    context: "stories",
    defaultKeys: [],
    allowInTextEntry: "never"
  })
  let unbind: (() => void) | null = null
  if (keyBinder) {
    const result = keyBinder(action.id, action.run)
    if (typeof result === "function") unbind = result as () => void
  } else {
    pendingKeys.push(action)
  }
  return () => {
    unregisterCommand()
    unbind?.()
    const index = pendingKeys.indexOf(action)
    if (index >= 0) pendingKeys.splice(index, 1)
  }
}

/** Installed once by the keyboard layer; binds anything registered earlier. */
export function setStoryActionKeyBinder(binder: StoryActionKeyBinder): void {
  keyBinder = binder
  for (const action of pendingKeys.splice(0)) {
    const result = binder(action.id, action.run)
    const entry = actions.get(action.id)
    if (entry && typeof result === "function") {
      const previous = entry.release
      entry.release = () => {
        previous()
        ;(result as () => void)()
      }
    }
  }
}

export function registerStoryAction(action: RegisteredStoryAction): () => void {
  actions.get(action.id)?.release()
  const releases: (() => void)[] = []
  if (action.surfaces.includes("swipe")) {
    releases.push(registerSwipeAction({ id: action.id, label: action.label }))
  }
  if (action.surfaces.includes("key")) releases.push(bindKey(action))
  const release = () => {
    for (const fn of releases.splice(0)) fn()
  }
  actions.set(action.id, { action, release })
  return () => {
    const entry = actions.get(action.id)
    if (entry?.action !== action) return
    entry.release()
    actions.delete(action.id)
  }
}

export function findStoryAction(id: string): RegisteredStoryAction | undefined {
  return actions.get(id)?.action
}

export function registeredStoryActions(): RegisteredStoryAction[] {
  return [...actions.values()].map((entry) => entry.action)
}
