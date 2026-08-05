import type { StoryListItem } from "./StoryListItem"

// Switching the open page between a story and its comments.
//
// The story is the one already mirrored into #selected_container — the row the
// shell shows for whatever the browser pane (Electron) or the active tab
// (extensions) is displaying. Using that rather than the keyboard cursor is the
// point: the command answers "I am reading this, show me the other side of it",
// so it must follow the page, not wherever the cursor happens to sit.

// The last URL the shell was told the active tab is showing. #selected_container
// only says *which* story is open, not which of its two URLs, and the row's own
// markup cannot answer that either — so the URL is kept alongside it.
let selectedUrl = ""

export function setSelectedUrl(url: string): void {
  selectedUrl = url
}

/**
 * The other side of the open story: its comments when the page is the story,
 * the story when the page is the comments. Null when there is no selected
 * story, when it has no comments to switch to, or when the open URL matches
 * neither — a stale mirror must not send the user somewhere unrelated.
 */
export function toggledStoryUrl(
  doc: Document = document
): string | null {
  const row = doc.querySelector<StoryListItem>("#selected_container story-item")
  const story = row?.story
  if (!story || !selectedUrl) return null
  if (story.matches_comment_url(selectedUrl)) return story.href
  if (!story.matches_story_url(selectedUrl)) return null
  return story.comment_url || null
}
