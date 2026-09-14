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
  conversations?: AddonConversationSurface
): Promise<void> {
  if (!href) return
  const request = ++latestRequest

  // A conversation page is about a story as much as that story's own page is.
  href = conversations?.storyHref?.(href) || sourceUrlFromReaderUrl(href) || href

  if (href.startsWith("about:reader?url=")) {
    const urlParams = new URLSearchParams(href.replace("about:reader", ""))
    const readerUrl = urlParams.get("url")
    if (readerUrl) href = decodeURIComponent(readerUrl)
  }

  const selectedContainer = document.querySelector("#selected_container")
  if (!selectedContainer) return

  const selectedStory = selectedContainer.querySelector<StoryListItem>("story-item")
  if (selectedStory && selectedStory.story.matches_url(href)) return

  const story = await client.findStoryByUrl(href)
  if (request !== latestRequest) return
  selectedContainer.innerHTML = ""

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

function sourceUrlFromReaderUrl(url: string): string | null {
  if (!url.startsWith("once-reader://")) return null
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== "http" && parsed.hostname !== "https") return null
    return new URL(`${parsed.hostname}:${parsed.pathname}${parsed.search}${parsed.hash}`).toString()
  } catch {
    return null
  }
}
