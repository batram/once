import { requireElement } from "../dom"
import type { StoryListItem } from "./StoryListItem"

/**
 * Current rendered order of one bucket, excluding rows hidden by search or
 * filtering.
 *
 * This lives apart from storyList so callers that only need the ordering — the
 * keyboard cursor — do not drag in the whole story-rendering stack. The import
 * of StoryListItem is type-only for the same reason.
 */
export function visibleStoryElements(bucket = "stories"): StoryListItem[] {
  const container = requireElement("#" + bucket)
  return Array.from(
    container.querySelectorAll<StoryListItem>("story-item.story")
  ).filter((row) =>
    !row.classList.contains("nomatch") &&
    !row.classList.contains("filtered") &&
    getComputedStyle(row).display !== "none"
  )
}
