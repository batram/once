// The actions a swipe stage can run. The built-in set is fixed; add-ons
// register more at runtime under `addon:` ids. Settings may name an add-on
// action that is not installed on this device: the id is kept so it survives
// sync, and the swipe does nothing until the add-on is present.

import { isAddonContributionId } from "@once/core"

export type SwipeActionId = string

export type BuiltinSwipeActionId =
  | "none"
  | "open"
  | "open-browser"
  | "open-reader"
  | "skip"
  | "toggle-read"
  | "toggle-bookmark"
  | "filter"

export const SWIPE_ACTION_LABELS: Readonly<Record<BuiltinSwipeActionId, string>> = Object.freeze({
  "none": "Nothing",
  "open": "Read · open",
  "open-browser": "Open in browser",
  "open-reader": "Open in reader",
  "skip": "Skip",
  "toggle-read": "Toggle read state",
  "toggle-bookmark": "Toggle bookmark",
  "filter": "Filter source"
})

export interface SwipeActionDescriptor {
  id: SwipeActionId
  label: string
}

const registered = new Map<SwipeActionId, SwipeActionDescriptor>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of [...listeners]) listener()
}

/** Adds an add-on action to the swipe lab's choices; returns the remover. */
export function registerSwipeAction(descriptor: SwipeActionDescriptor): () => void {
  if (!isAddonContributionId(descriptor.id)) {
    throw new Error(`Swipe actions from add-ons must use addon: ids, got ${descriptor.id}`)
  }
  registered.set(descriptor.id, { ...descriptor })
  notify()
  return () => {
    if (registered.delete(descriptor.id)) notify()
  }
}

/** Runs whenever the set of registered actions changes. */
export function onSwipeActionsChanged(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Built-ins first, then registered add-on actions in registration order. */
export function listSwipeActions(): SwipeActionDescriptor[] {
  return [
    ...Object.entries(SWIPE_ACTION_LABELS).map(([id, label]) => ({ id, label })),
    ...registered.values()
  ]
}

export function swipeActionLabel(id: SwipeActionId): string {
  if (id in SWIPE_ACTION_LABELS) return SWIPE_ACTION_LABELS[id as BuiltinSwipeActionId]
  return registered.get(id)?.label ?? "Unavailable add-on action"
}

/** Built in or registered here: the action would actually run on this device. */
export function isSwipeActionAvailable(id: SwipeActionId): boolean {
  return id in SWIPE_ACTION_LABELS || registered.has(id)
}

/** A built-in id, a registered one, or any well-formed add-on id. */
export function isSwipeActionId(value: unknown): value is SwipeActionId {
  return typeof value === "string" &&
    (value in SWIPE_ACTION_LABELS || registered.has(value) || isAddonContributionId(value))
}
