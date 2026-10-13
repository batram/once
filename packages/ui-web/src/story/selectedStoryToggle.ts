import { storyPageUrls, StoryPageContext } from "@once/core"
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
let selectedContext: StoryPageContext | undefined

// A switch the command sent that the shell has not reported yet. The tab keeps
// reporting the page being left until the navigation commits (its load
// completing, its title), and those readings arrive after the switch was
// recorded; taken as the open page, they made a second press switch to the
// same side again. They are passed over until anything else is reported, for
// a few seconds at most, so a navigation that never lands cannot pin it.
let leaving: { url: string; until: number } | null = null
const SWITCH_SETTLES_WITHIN_MS = 3_000

export function setSelectedUrl(url: string, context?: StoryPageContext): void {
  if (leaving) {
    if (url === leaving.url && Date.now() < leaving.until) return
    leaving = null
  }
  selectedUrl = url
  selectedContext = context
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
  const urls = storyPageUrls(selectedUrl, selectedContext)
  if (urls.some(url => story.matches_comment_url(url))) return story.href
  if (!urls.some(url => story.matches_story_url(url))) return null
  return story.comment_url || null
}

/**
 * The toggle command's step: the other side of the open story, recorded as
 * the open URL since the command is about to navigate there, so a second
 * press before the shell reports the navigation switches back.
 */
export function switchToggledStoryUrl(doc: Document = document): string | null {
  const url = toggledStoryUrl(doc)
  if (!url) return null
  leaving = { url: selectedUrl, until: Date.now() + SWITCH_SETTLES_WITHIN_MS }
  selectedUrl = url
  selectedContext = undefined
  return url
}
