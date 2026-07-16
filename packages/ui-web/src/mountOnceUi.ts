import { OnceClient } from "@once/app"
import { addCollectorColorStyles } from "./CollectorStyles"
import { LoaderInsights } from "./LoaderInsights"
import { HoverUrlIndicator } from "./HoverUrlIndicator"
import * as Menu from "./menu"
import * as Search from "./search"
import { setOnceClient } from "./client"
import { SettingsPanel } from "./SettingsPanel"
import { StoryHistory } from "./StoryHistory"
import * as StoryList from "./StoryList"
import { StoryListItem } from "./StoryListItem"
import { ReaderView } from "./reader/ReaderView"
import { SourcePickerView } from "./picker/SourcePickerView"
import { bindMenuCollapseControls } from "./MenuCollapse"
import { AppUpdater, bindAppUpdateControls } from "./AppUpdateControls"

export interface MountOnceUiOptions {
  appVersion: string
  buildChannel: "release" | "dev"
  showHoveredLinks?: boolean
  onMenuCollapsedChanged?: (collapsed: boolean) => void
  initialStoryLoad?: "network" | "cache" | "disabled"
  updater?: AppUpdater
  sourcePicker?: boolean
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

  bindMenuCollapseControls(options.onMenuCollapsedChanged)
  bindAppUpdateControls(options.updater)

  const settingsPanel = new SettingsPanel(client)
  if (options.sourcePicker === false) {
    const picker = document.querySelector<HTMLElement>("#pick_source_button")
    if (picker) picker.hidden = true
    const pickerStatus = document.querySelector<HTMLElement>("#pick_source_status")
    if (pickerStatus) pickerStatus.hidden = true
  } else {
    SourcePickerView.mount(client)
  }
  new StoryHistory(client)
  StoryList.init(client)
  Menu.init(client)
  LoaderInsights.init(client)
  if (options.showHoveredLinks) HoverUrlIndicator.mount()
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
    await StoryList.showStoredStoriesIfEmpty(client)
  }
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
  if (selectedStory && selectedStory.story.matches_url(href)) return

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
