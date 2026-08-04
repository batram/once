import { StoryMenuActionId, executeStoryMenuAction } from "../menu/storyContextMenu"
import type { StoryCursor } from "../story/storyCursor"
import { KeyCommandDefinition, registerKeyCommand } from "./commands"

/**
 * Story menu actions offered as bindable keys.
 *
 * The labels are deliberately not the menu's: those are contextual ("Mark as
 * read" flips to "Mark as unread"), while a settings row has to name one stable
 * thing. Open, comments, undo and redo are left out because built-in commands
 * already cover them, as are purge and inspect, which are development tools.
 *
 * None of these ship with a default chord. They exist so a user can bind what
 * they actually use, and they are the pattern a plugin will follow: register a
 * command, register a handler, and it appears in settings ready to be bound.
 */
const BINDABLE_STORY_ACTIONS: {
  id: StoryMenuActionId
  label: string
  platform?: KeyCommandDefinition["platform"]
}[] = [
  { id: "open-browser", label: "Open story in browser" },
  { id: "open-new-tab", label: "Open story in a new tab" },
  { id: "open-background-tab", label: "Open story in a background tab" },
  { id: "open-new-window", label: "Open story in a new window", platform: "electron" },
  { id: "open-external", label: "Open story in the default browser", platform: "electron" },
  { id: "open-original", label: "Open the original URL" },
  { id: "open-reader", label: "Open story in reader" },
  { id: "toggle-read", label: "Toggle read state" },
  { id: "toggle-bookmark", label: "Toggle bookmark" },
  { id: "filter", label: "Filter story" },
  { id: "search-domain", label: "Search this domain" },
  { id: "copy-link", label: "Copy link address" },
  { id: "copy-original-link", label: "Copy original link address" }
]

export const storyActionCommandId = (id: StoryMenuActionId): string =>
  `story-action.${id}`

for (const action of BINDABLE_STORY_ACTIONS) {
  registerKeyCommand({
    id: storyActionCommandId(action.id),
    label: action.label,
    group: "actions",
    context: "stories",
    defaultKeys: [],
    allowInTextEntry: "never",
    platform: action.platform
  })
}

/** Points every registered story action at whichever row holds the cursor. */
export function registerStoryActionHandlers(
  cursor: StoryCursor,
  register: (id: string, handler: () => void) => unknown
): void {
  for (const action of BINDABLE_STORY_ACTIONS) {
    register(storyActionCommandId(action.id), () => {
      const row = cursor.current()
      if (row) void executeStoryMenuAction(action.id, row)
    })
  }
}
