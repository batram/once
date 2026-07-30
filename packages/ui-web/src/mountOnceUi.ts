import { OnceClient } from "@once/app"
import { addCollectorColorStyles } from "./collectorStyles"
import { LoaderInsights } from "./shell/LoaderInsights"
import { HoverUrlIndicator } from "./shell/HoverUrlIndicator"
import * as PanelNavigation from "./shell/panelNavigation"
import * as SidebarFilters from "./shell/sidebarFilters"
import * as StorySearch from "./story/storySearch"
import { setOnceClient } from "./client"
import { SettingsPanel } from "./settings/SettingsPanel"
import { StoryHistory } from "./story/StoryHistory"
import * as StoryList from "./story/storyList"
import { StoryListItem } from "./story/StoryListItem"
import { SwipeConfig } from "./story/swipe/geometry"
import { ReaderView } from "./reader/ReaderView"
import { SourcePickerView } from "./picker/SourcePickerView"
import { bindMenuCollapseControls } from "./shell/menuCollapse"
import { AppUpdater, bindAppUpdateControls } from "./settings/appUpdateControls"

export interface MountOnceUiOptions {
  appVersion: string
  buildChannel: "release" | "dev"
  buildIdentifier?: string
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
  StoryListItem.devToolsEnabled = options.buildChannel === "dev"
  ReaderView.mount(client)

  const version = document.querySelector<HTMLElement>(
    "[data-testid='app-version']"
  )
  if (version) {
    const buildBlip = options.buildChannel === "dev"
      ? `dev${options.buildIdentifier ? ` ${options.buildIdentifier}` : ""}`
      : options.buildIdentifier
    version.textContent = buildBlip
      ? `${options.appVersion} (${buildBlip})`
      : options.appVersion
    version.dataset.buildChannel = options.buildChannel
  }

  bindMenuCollapseControls(options.onMenuCollapsedChanged)
  bindAppUpdateControls(options.updater, (message, details) =>
    LoaderInsights.showErrorMessage(message, details)
  )

  // Rows read the swipe config at gesture time, so it has to be current
  // before the first row can be dragged — and after any settings change.
  SwipeConfig.current = await client.getSwipeSettings()
  client.subscribe("settingsChanged", ({ section }) => {
    if (section !== "swipe") return
    void client.getSwipeSettings().then((settings) => {
      SwipeConfig.current = settings
    })
  })

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
  PanelNavigation.init()
  SidebarFilters.init(client)
  LoaderInsights.init(client, {
    clearSourceErrors: () => settingsPanel.clearSourceErrors(),
    highlightSource: (sourceUrl) => settingsPanel.highlightSource(sourceUrl),
    showErrorLog: (logId) => settingsPanel.showErrorLog(logId),
    showStory: (storyUrl) => settingsPanel.showStory(storyUrl)
  })
  if (options.showHoveredLinks) HoverUrlIndicator.mount()
  StorySearch.init()
  addCollectorColorStyles()
  await settingsPanel.ready

  client.subscribe("selectedUrlChanged", ({ url }) => {
    updateSelected(client, url)
  })
  client.subscribe("searchRequested", ({ query }) => {
    StorySearch.searchStories(query)
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
