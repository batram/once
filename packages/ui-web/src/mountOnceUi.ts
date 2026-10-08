import { OnceClient } from "@once/app"
import { DevAddonSource, mountAddons } from "./addons/mountAddons"
import { addonPanelConversations } from "./addons/addonPanel"
import { PanelPageHost, setPanelPageHost } from "./story/commentsPanel"
import type { BundledAddonFiles } from "./addons/bundledAddons"
import type { AddonConversationSurface } from "./addons/AddonTrays"
import { addCollectorColorStyles } from "./collectorStyles"
import { LoaderInsights } from "./shell/LoaderInsights"
import { HoverUrlIndicator } from "./shell/HoverUrlIndicator"
import * as PanelNavigation from "./shell/panelNavigation"
import * as SidebarFilters from "./shell/sidebarFilters"
import * as StorySearch from "./story/storySearch"
import { setOnceClient } from "./client"
import { mountTabsPanel } from "./tabsync/tabsPanel"
import { mountTabSyncNotices, type TabSyncNoticeOptions } from "./tabsync/tabSyncNotices"
import { SettingsPanel } from "./settings/SettingsPanel"
import { StoryHistory } from "./story/StoryHistory"
import { setSelectedUrl } from "./story/selectedStoryToggle"
import * as StoryList from "./story/storyList"
import { updateSelectedStory } from "./story/selectedStory"
import { StoryListItem } from "./story/StoryListItem"
import { registerStoryButton } from "./story/storyButtonPreferences"
import { SwipeConfig } from "./story/swipe/geometry"
import { ReaderView } from "./reader/ReaderView"
import { installStoredContentSaver } from "./reader/storedContent"
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
  backgroundInitialStoryLoad?: boolean
  /**
   * Caps the reload button spin and the pull-to-refresh strip at this many
   * ms. For shells that show reload progress somewhere calmer than a spinner.
   */
  reloadSpinTimeout?: number
  updater?: AppUpdater
  /** Shows the Tabs entry in the side panel menu (the extensions; Electron by choice). */
  tabsPanel?: boolean
  /** Where tab sync notices dock and what they may do beyond the shared default. */
  tabSyncNotices?: TabSyncNoticeOptions
  /** Scans a pairing code with the camera, where the device has one (mobile). */
  scanPairingCode?: () => Promise<string | null>
  sourcePicker?: boolean
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
  /**
   * Where this platform serves the add-on sandbox page (`addon-sandbox.html`
   * with the sandbox runtime). Absent means scripted add-ons cannot run here;
   * declarative ones still do.
   */
  addonSandboxUrl?: string
  /**
   * Whether this shell hands the filter-list and userscript documents to
   * something that runs them — bundled extensions on Electron, the native
   * surface on a phone. The sidepanel extensions and the mobile web build
   * subscribe to nothing, so their Extensions section stays out of Settings
   * rather than offering a save that reaches no page.
   */
  extensionSettings?: boolean
  /**
   * Development add-ons the host reads from disk (Electron's `ONCE_ADDONS`):
   * manifests with their code, registered beside the synced ones and never
   * written to the document.
   */
  devAddons?: DevAddonSource
  /**
   * The add-on packages built into this app (`__ONCE_BUNDLED_ADDONS__`, from
   * `scripts/bundled-addons.js`): installed on first start, removable, and
   * offered again from the import page.
   */
  bundledAddons?: readonly BundledAddonFiles[]
  /** How this shell continues an addon tray's conversation in its main browser surface. */
  addonConversations?: AddonConversationSurface
  /** The host can keep a conversation beside an independently navigable page. */
  addonPanel?: boolean
  /**
   * How this shell shows a web page inside the panel, such as a story's
   * comments beside the current page. Absent means an iframe.
   */
  panelPages?: PanelPageHost
}

export async function mountOnceUi(
  client: OnceClient,
  options: MountOnceUiOptions
): Promise<void> {
  // Before anything touches the keyboard: getKeyboardDispatcher() loads the
  // stored bindings on first use, and those are filtered against the shell.
  setShell(options.shell ?? "electron")
  if (options.panelPages) setPanelPageHost(options.panelPages)
  setOnceClient(client)
  StoryListItem.devToolsEnabled = options.buildChannel === "dev"
  if (StoryListItem.devToolsEnabled) registerStoryButton("purge", "Purge story (development)")
  ReaderView.mount(client)
  installStoredContentSaver(client, {
    reportError: (message, details) => LoaderInsights.showErrorMessage(message, details)
  })
  mountAddons(client, { sandboxUrl: options.addonSandboxUrl, devAddons: options.devAddons, bundledAddons: options.bundledAddons,
    conversations: options.addonConversations, panelConversations: options.addonPanel ? addonPanelConversations(client) : undefined })

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

  // Mobile lays the menu out as a bottom tab bar, which has no edge to drag.
  bindMenuCollapseControls(options.onMenuCollapsedChanged, { resizable: options.shell !== "mobile" })
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

  const extensionSettings = document.querySelector<HTMLElement>("#extension_settings")
  if (options.extensionSettings && extensionSettings) extensionSettings.hidden = false

  const settingsPanel = new SettingsPanel(client, {
    scanPairingCode: options.scanPairingCode
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

  StoryList.init(client, { spinTimeout: options.reloadSpinTimeout })
  mountTabsPanel(client, options.tabsPanel === true)
  mountTabSyncNotices(client, options.tabSyncNotices)
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

  client.subscribe("selectedUrlChanged", ({ url, context }) => {
    // Which of the story's two URLs is open, which the mirrored row cannot say.
    setSelectedUrl(url, context)
    void updateSelectedStory(client, url, options.addonConversations, context)
  })
  client.subscribe("searchRequested", ({ query }) => {
    StorySearch.searchStories(query)
  })

  await loadInitialStories(client, options)
}

async function loadInitialStories(client: OnceClient, options: MountOnceUiOptions): Promise<void> {
  // Cache-first: a launch only fetches sources whose window has passed.
  const initialStoryLoad = options.initialStoryLoad || "cache"
  if (initialStoryLoad !== "disabled") {
    const loading = client.reloadStories(
      initialStoryLoad === "cache" ? "cache-first" : "network-only"
    )
    if (options.backgroundInitialStoryLoad) {
      void loading.catch((error) => console.error("Initial story load failed", error))
    } else {
      await loading
    }
  }
}

