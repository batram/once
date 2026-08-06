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
import { setSelectedUrl } from "./story/selectedStoryToggle"
import * as StoryList from "./story/storyList"
import { StoryListItem } from "./story/StoryListItem"
import { SwipeConfig } from "./story/swipe/geometry"
import { ReaderView } from "./reader/ReaderView"
import { SourcePickerView } from "./picker/SourcePickerView"
import { bindMenuCollapseControls } from "./shell/menuCollapse"
import { getKeyboardDispatcher } from "./keyboard"
import { ShellId, setShell } from "./keyboard/commands"
import { mountKeyboard } from "./keyboard/mountKeyboard"
import { AppUpdater, bindAppUpdateControls } from "./settings/appUpdateControls"
import {
  BrowserManagedShortcut,
  KeyboardSettingsView
} from "./settings/KeyboardSettingsView"

export interface MountOnceUiOptions {
  /**
   * Which shell is mounting. Decides which keyboard commands exist at all —
   * the sidepanel extensions cannot cycle tabs or focus an address bar, so
   * those never reach their settings. Defaults to the full Electron catalogue.
   */
  shell?: ShellId
  appVersion: string
  buildChannel: "release" | "dev"
  buildIdentifier?: string
  showHoveredLinks?: boolean
  onMenuCollapsedChanged?: (collapsed: boolean) => void
  initialStoryLoad?: "network" | "cache" | "disabled"
  updater?: AppUpdater
  sourcePicker?: boolean
  /**
   * Leaves Settings entirely when the back chevron is pressed on the section
   * index. Supplying it also keeps that chevron visible there — see
   * SettingsPanelOptions.exitSettings.
   */
  exitSettings?: () => void
  /**
   * Called with every bound chord whenever the user edits their shortcuts.
   * The Electron shell forwards these to the main process so keys pressed
   * inside a page still reach the shell.
   */
  onKeyBindingsChanged?: (chords: string[]) => void
  /**
   * Shortcuts the host owns, listed read-only alongside Once's own. The
   * extensions pass their manifest command here: it is the only shortcut that
   * reaches Once while a web page has focus, and only the browser can rebind it.
   */
  browserShortcuts?: readonly BrowserManagedShortcut[]
}

export async function mountOnceUi(
  client: OnceClient,
  options: MountOnceUiOptions
): Promise<void> {
  // Before anything touches the keyboard: getKeyboardDispatcher() loads the
  // stored bindings on first use, and those are filtered against the shell.
  setShell(options.shell ?? "electron")
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

  // Rows read the swipe config at gesture time. The built-in defaults are
  // safe while storage opens, and later settings changes refresh it. A delayed
  // IndexedDB read must not prevent the shell and its error UI from mounting.
  void client.getSwipeSettings().then((settings) => {
    SwipeConfig.current = settings
  }).catch((error) => {
    LoaderInsights.showErrorMessage(
      "Swipe settings could not be loaded; using defaults",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    )
  })
  client.subscribe("settingsChanged", ({ section }) => {
    if (section !== "swipe") return
    void client.getSwipeSettings().then((settings) => {
      SwipeConfig.current = settings
    })
  })

  // Unhidden before SettingsPanel constructs: it skips blocks that are still
  // hidden, which is how a section stays out of the shells that lack it. The
  // rows themselves are built afterwards, once there is a panel to refresh.
  const shortcutsHost = document.querySelector<HTMLElement>("#keyboard_shortcuts")
  const shortcutsBlock = document.querySelector<HTMLElement>("#keyboard_settings")
  const wantsShortcuts = Boolean(shortcutsHost) && Boolean(shortcutsBlock) &&
    document.body.dataset.platform !== "mobile"
  if (wantsShortcuts && shortcutsBlock) shortcutsBlock.hidden = false

  const settingsPanel = new SettingsPanel(client, {
    exitSettings: options.exitSettings
  })
  if (options.sourcePicker === false) {
    const picker = document.querySelector<HTMLElement>("#pick_source_button")
    if (picker) picker.hidden = true
    const pickerStatus = document.querySelector<HTMLElement>("#pick_source_status")
    if (pickerStatus) pickerStatus.hidden = true
  } else {
    SourcePickerView.mount(client)
  }
  mountKeyboard(new StoryHistory(client))
  if (wantsShortcuts && shortcutsHost) {
    new KeyboardSettingsView(shortcutsHost, () => {
      options.onKeyBindingsChanged?.(getKeyboardDispatcher().boundChords())
      settingsPanel.refreshSettingsSearch()
    }, options.browserShortcuts ?? [])
  }

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
  void settingsPanel.ready.catch((error) => {
    LoaderInsights.showErrorMessage(
      "Settings could not be loaded",
      error instanceof Error ? `${error.name}: ${error.message}` : String(error)
    )
  })

  client.subscribe("selectedUrlChanged", ({ url }) => {
    // Which of the story's two URLs is open, which the mirrored row cannot say.
    setSelectedUrl(url)
    updateSelected(client, url)
  })
  client.subscribe("searchRequested", ({ query }) => {
    StorySearch.searchStories(query)
  })

  // Cache-first: a launch shows what is already stored and only fetches the
  // sources whose window has passed, so opening the app is not a thundering
  // herd on every feed the user follows.
  const initialStoryLoad = options.initialStoryLoad || "cache"
  if (initialStoryLoad !== "disabled") {
    await client.reloadStories(
      initialStoryLoad === "cache" ? "cache-first" : "network-only"
    )
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
