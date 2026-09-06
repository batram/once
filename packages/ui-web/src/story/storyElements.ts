import { applyStoryButtonPreferences } from "./storyButtonPreferences"
import type { StoryListItem } from "./StoryListItem"

/**
 * Elements a row shows beyond its own: a button beside the built-in ones, a
 * badge on the title line, or a line under the title. Built-ins (the reader's
 * outline button) and add-ons register the same way, keyed by id, so an
 * add-on's contribution looks like ours and can be removed cleanly.
 */
export interface StoryElementContribution {
  id: string
  slot: "button" | "title" | "line" | "tray"
  /** Returns nothing when the element does not apply to this row. */
  render(row: StoryListItem): HTMLElement | null
}

const registered = new Map<string, StoryElementContribution>()

export function registerStoryElement(contribution: StoryElementContribution): () => void {
  registered.set(contribution.id, contribution)
  return () => {
    registered.delete(contribution.id)
  }
}

function slotOf(row: StoryListItem, slot: StoryElementContribution["slot"]): HTMLElement {
  if (slot === "tray") return row
  if (slot === "title") return row.title_line
  if (slot === "line") return row.substories_el
  return row.button_group
}

/** Adds every registered element that applies; the row calls this once built. */
export function applyStoryElements(row: StoryListItem): void {
  for (const contribution of registered.values()) {
    let element: HTMLElement | null
    try {
      element = contribution.render(row)
    } catch (error) {
      console.error(`Story element ${contribution.id} failed to render`, error)
      continue
    }
    if (!element) continue
    element.dataset.storyElement = contribution.id
    const target = slotOf(row, contribution.slot)
    // Buttons stay ahead of the ⋮ menu button, which the row appends last.
    if (contribution.slot === "button" && row.menu_btn?.parentElement === target) {
      target.insertBefore(element, row.menu_btn)
    } else {
      target.appendChild(element)
    }
  }
  applyStoryButtonPreferences(row)
}

/** Re-renders one row's contributed elements, after the row's story changed. */
export function refreshRowElements(row: StoryListItem): void {
  for (const stale of row.querySelectorAll("[data-story-element]")) stale.remove()
  applyStoryElements(row)
}

/** Re-renders the elements on every row already on screen, after the set changed. */
export function refreshStoryElements(): void {
  for (const row of document.querySelectorAll<StoryListItem>("story-item")) {
    refreshRowElements(row)
  }
}
