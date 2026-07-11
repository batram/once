import { OnceClient } from "@once/app"
import { addCollectorColorStyles } from "./CollectorStyles"
import { LoaderInsights } from "./LoaderInsights"
import * as Menu from "./menu"
import * as Search from "./search"
import { setOnceClient } from "./client"
import { SettingsPanel } from "./SettingsPanel"
import { StoryHistory } from "./StoryHistory"
import * as StoryList from "./StoryList"
import { StoryListItem } from "./StoryListItem"
import { ReaderView } from "./reader/ReaderView"

export interface MountOnceUiOptions {
  appVersion: string
  buildChannel: "release" | "dev"
  showHoveredLinks?: boolean
  onMenuCollapsedChanged?: (collapsed: boolean) => void
  initialStoryLoad?: "network" | "cache" | "disabled"
}

export async function mountOnceUi(
  client: OnceClient,
  options: MountOnceUiOptions
): Promise<void> {
  setOnceClient(client)
  ReaderView.mount(client)

  const version = document.querySelector<HTMLElement>(
    "[data-testid='app-version']"
  )
  if (version) {
    version.textContent =
      options.buildChannel === "dev"
        ? `${options.appVersion} (dev)`
        : options.appVersion
    version.dataset.buildChannel = options.buildChannel
  }

  const settingsPanel = new SettingsPanel(client)
  new StoryHistory(client)
  StoryList.init(client)
  Menu.init(client)
  LoaderInsights.init(client, {
    showHoveredLinks: options.showHoveredLinks || false
  })
  Search.init()
  addCollectorColorStyles()
  await settingsPanel.ready

  client.subscribe("selectedUrlChanged", ({ url }) => {
    updateSelected(client, url)
  })
  client.subscribe("searchRequested", ({ query }) => {
    Search.searchStories(query)
  })

  const initialStoryLoad = options.initialStoryLoad || "network"
  if (initialStoryLoad !== "disabled") {
    await client.reloadStories(initialStoryLoad === "cache")
  }

  document.querySelectorAll<HTMLElement>(".collapsebutton").forEach((element) => {
    element.onclick = () => {
      const collapsed = toggleMenu()
      options.onMenuCollapsedChanged?.(collapsed)
    }
  })
}

function toggleMenu(): boolean {
  const menu = document.querySelector("#menu")
  if (!menu) return false

  const collapsed = menu.classList.toggle("collapse")
  document.querySelectorAll<HTMLElement>(".collapsebutton").forEach((element) => {
    element.innerText = collapsed ? ">" : "<"
  })
  return collapsed
}

async function updateSelected(client: OnceClient, href: string): Promise<void> {
  if (!href) return

  href = sourceUrlFromReaderUrl(href) || href

  if (href.startsWith("about:reader?url=")) {
    const urlParams = new URLSearchParams(href.replace("about:reader", ""))
    const readerUrl = urlParams.get("url")
    if (readerUrl) href = decodeURIComponent(readerUrl)
  }

  const selectedContainer = document.querySelector("#selected_container")
  if (!selectedContainer) return

  const selectedStory = selectedContainer.querySelector<StoryListItem>("story-item")
  if (selectedStory && selectedStory.story.href === href) return

  const story = await client.findStoryByUrl(href)
  selectedContainer.innerHTML = ""

  if (story) {
    const storyElement = new StoryListItem(story)
    storyElement.classList.add("selected")
    selectedContainer.append(storyElement)
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
