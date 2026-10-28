import { readerSourceUrl, storyPageUrls, StoryPageContext } from "@once/core"
import { OnceClient } from "@once/app"
import type { AddonConversationSurface } from "../addons/AddonTrays"
import { StoryListItem } from "./StoryListItem"
import { refreshRowElements } from "./storyElements"

// Mirrors the story behind the browser's open URL into #selected_container.
//
// URL changes arrive faster than lookups settle: activating a tab that is
// still loading reports about:blank, and its miss walks the story store and
// the whole working set, while the real URL that follows is a cache hit.
// Only the newest URL may write the container, or the late miss wipes a
// selection that was already correct.
let latestRequest = 0

export async function updateSelectedStory(
  client: OnceClient,
  href: string,
  conversations?: AddonConversationSurface,
  context?: StoryPageContext
): Promise<void> {
  if (!href) return
  const request = ++latestRequest

  // A conversation page is about a story as much as that story's own page is.
  href = conversations?.storyHref?.(href) || readerSourceUrl(href) || href

  if (href.startsWith("about:reader?url=")) {
    const urlParams = new URLSearchParams(href.replace("about:reader", ""))
    const readerUrl = urlParams.get("url")
    if (readerUrl) href = decodeURIComponent(readerUrl)
  }

  const selectedContainer = document.querySelector<HTMLElement>("#selected_container")
  if (!selectedContainer) return

  const candidates = storyPageUrls(href, context)
  const selectedStory = selectedContainer.querySelector<StoryListItem>("story-item")
  if (selectedStory && candidates.some(url => selectedStory.story.matches_url(url))) {
    selectedContainer.hidden = false
    return
  }
  // The row belongs to the page just left, so it goes now rather than when the
  // lookup settles: a miss takes tens of milliseconds, and where the mirror sits
  // above the browser (Electron) its height places the tab's view, which would
  // show those frames at the old offset and then jump. A hit settles within
  // the same task, so a story-to-story switch never paints the gap.
  selectedContainer.hidden = true

  let story = null
  for (const url of candidates) {
    story = await client.findStoryByUrl(url)
    if (request !== latestRequest) return
    if (story) break
  }
  if (request !== latestRequest) return
  selectedContainer.innerHTML = ""
  selectedContainer.hidden = false

  if (story) {
    const storyElement = new StoryListItem(story)
    storyElement.classList.add("selected")
    selectedContainer.append(storyElement)
    // Contributed elements were rendered while the row was still detached, so
    // a tray keyed on where the row lives (list or mirror) saw a list row and
    // stayed closed; now that the row is in place its own state applies.
    refreshRowElements(storyElement)
  }
}
