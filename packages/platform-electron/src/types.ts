export interface ElectronRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ElectronPoint {
  x: number
  y: number
}

export interface ElectronStoryMenuItem {
  id: string
  label: string
  group: string
  enabled: boolean
  visible: boolean
}

export interface ElectronRedirectRule {
  match_url: string
  replace_url: string
}

export interface ElectronTabState {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  audible: boolean
  hasPlayedAudio: boolean
  muted: boolean
  active: boolean
  loadError: string | null
}

export interface ElectronFetchRequest {
  url: string
  method: string
  headers: [string, string][]
  body?: ArrayBuffer
  /** Send the browser session's cookies. Absent means none, as before. */
  credentials?: "include"
  redirect?: "error"
  requestId?: string
}

export interface ElectronFetchResponse {
  status: number
  statusText: string
  headers: [string, string][]
  body: ArrayBuffer
}

export type ElectronOpenTarget = "_self" | "middle" | "blank" | string

export type ElectronBuildChannel = "release" | "dev"

export interface ElectronBuildInfo {
  version: string
  channel: ElectronBuildChannel
  buildIdentifier: string
  platform: string
}

export type ElectronUpdateState =
  | "disabled"
  | "idle"
  | "checking"
  | "available"
  | "current"
  | "downloaded"
  | "error"

export interface ElectronUpdateStatus {
  state: ElectronUpdateState
  message?: string
}

export type ElectronFocusSurface = "browser" | "shell"

export interface ElectronExtensionSettings {
  filterLists: import("@once/core").FilterListsDocument
  userscripts: import("@once/core").UserscriptsDocument
}

/** The parts of those documents an extension changed on its own. */
export interface ElectronAdoptedExtensionSettings {
  userscripts?: import("@once/core").UserscriptsDocument
}

/** One loaded extension as the toolbar shows it. */
export interface ElectronExtensionInfo {
  settingsStatus?: { state: "applying" | "applied" | "failed"; error?: string }
  /** Opaque, stable per extension; what the popup call names. */
  host: string
  name: string
  title: string
  badgeText: string
  badgeBackgroundColor: string | null
  /** Data URL of the toolbar icon, when the extension ships one. */
  icon: string | null
  enabled: boolean
  hasPopup: boolean
}

export interface ElectronBridge {
  app: {
    getBuildInfo(): Promise<ElectronBuildInfo>
    getUpdateStatus(): Promise<ElectronUpdateStatus>
    checkForUpdates(): Promise<ElectronUpdateStatus>
    onUpdateStatusChanged(
      handler: (status: ElectronUpdateStatus) => void
    ): () => void
  }
  fetch(request: ElectronFetchRequest): Promise<ElectronFetchResponse>
  cancelFetch?(requestId: string): Promise<void>
  settings: {
    getSyncUrl(): Promise<string>
    setSyncUrl(syncUrl: string): Promise<void>
    getCacheTime(): Promise<number>
    setCacheTime(cacheTime: string): Promise<void>
    /** Encrypted at rest like the sync URL; "" removes the entry. */
    getSecret(key: string): Promise<string>
    setSecret(key: string, value: string): Promise<void>
    /** Full accessibility tree for screen readers; applied immediately. */
    getAccessibility(): Promise<boolean>
    setAccessibility(enabled: boolean): Promise<void>
  }
  tabs: {
    getAll(): Promise<ElectronTabState[]>
    openUrl(url: string, target: ElectronOpenTarget): Promise<void>
    /**
     * `tabId` names the tab that asked for the document. Without it the active
     * tab is used, which is only correct when nothing can have moved on since.
     */
    openReader(
      html: string,
      sourceUrl: string,
      target: ElectronOpenTarget,
      tabId?: string
    ): Promise<void>
    showReaderError(sourceUrl: string, error: string, tabId?: string): Promise<void>
    create(url?: string, active?: boolean): Promise<string>
    activate(id: string): Promise<void>
    close(id: string): Promise<void>
    navigate(id: string, url: string): Promise<void>
    back(id: string): Promise<void>
    forward(id: string): Promise<void>
    reload(id: string): Promise<void>
    stop(id: string): Promise<void>
    duplicate(id: string): Promise<string>
    reorder(id: string, beforeId?: string): Promise<void>
    moveHere(id: string, beforeId?: string): Promise<void>
    detach(id: string, point?: ElectronPoint): Promise<void>
    toggleMuted(id: string): Promise<void>
    openDroppedUrls(urls: string[]): Promise<void>
    startSourcePicker(url?: string): Promise<import("@once/core").StorySource | null>
    showMenu(id: string, point: ElectronPoint): Promise<void>
    setBounds(bounds: ElectronRect): Promise<void>
    restoreClosed(): Promise<string | null>
    focusContent(): Promise<void>
    onChanged(handler: (tabs: ElectronTabState[]) => void): () => void
    onRegenerateReader(
      handler: (sourceUrl: string, tabId: string) => void
    ): () => void
  }
  storyMenu: {
    show(
      items: ElectronStoryMenuItem[],
      point: ElectronPoint
    ): Promise<string | null>
    openExternal(url: string): Promise<void>
    openWindow(url: string): Promise<void>
  }
  extensions: {
    list(): Promise<ElectronExtensionInfo[]>
    /** Toggles the extension's popup under the toolbar button at `anchor`. */
    openPopup(host: string, anchor: ElectronRect): Promise<void>
    onChanged(handler: () => void): () => void
    /** Hands the synced documents to the extensions that act on them. */
    applySettings(settings: ElectronExtensionSettings): Promise<void>
    /**
     * A change made in an extension's own dashboard rather than in Once's
     * settings — a userscript edited, toggled, added or deleted in
     * Violentmonkey. The shell saves it into its document, where it syncs.
     */
    onSettingsAdopted(
      handler: (settings: ElectronAdoptedExtensionSettings) => void
    ): () => void
  }
  addons: {
    pickDirectory(): Promise<void>
    removeDirectory(directory: string): Promise<void>
    /** Development add-ons from `ONCE_ADDONS` directories; empty in packaged builds. */
    devEntries(): Promise<ElectronDevAddon[]>
    /** Fires when a file in one of those directories changes. */
    onDevChanged(handler: () => void): () => void
  }
  window: {
    setFullscreen(fullscreen: boolean): Promise<void>
    create(): Promise<void>
    focusShell(): Promise<void>
    /** Chords the main process should steal from a focused page and forward. */
    setForwardedKeys(chords: string[]): Promise<void>
    onKeyCommand(handler: (chord: string) => void): () => void
    /** Where native focus actually went: a browser tab, or the shell itself. */
    onNativeFocusChanged(handler: (surface: ElectronFocusSurface) => void): () => void
    setRedirects(redirects: ElectronRedirectRule[]): Promise<void>
    setBackgroundColor(color: string): Promise<void>
    onTargetUrlChanged(handler: (url: string) => void): () => void
    onFullscreenChanged(handler: (fullscreen: boolean) => void): () => void
  }
}

export const ELECTRON_IPC = {
  appGetBuildInfo: "once:app:get-build-info",
  appGetUpdateStatus: "once:app:get-update-status",
  appCheckForUpdates: "once:app:check-for-updates",
  appUpdateStatusChanged: "once:app:update-status-changed",
  fetch: "once:fetch",
  cancelFetch: "once:fetch-cancel",
  getSyncUrl: "once:settings:get-sync-url",
  setSyncUrl: "once:settings:set-sync-url",
  getCacheTime: "once:settings:get-cache-time",
  setCacheTime: "once:settings:set-cache-time",
  getAccessibility: "once:settings:get-accessibility",
  setAccessibility: "once:settings:set-accessibility",
  getSecret: "once:settings:get-secret",
  setSecret: "once:settings:set-secret",
  tabsGetAll: "once:tabs:get-all",
  tabsOpenUrl: "once:tabs:open-url",
  tabsOpenReader: "once:tabs:open-reader",
  tabsShowReaderError: "once:tabs:show-reader-error",
  tabsCreate: "once:tabs:create",
  tabsActivate: "once:tabs:activate",
  tabsClose: "once:tabs:close",
  tabsNavigate: "once:tabs:navigate",
  tabsBack: "once:tabs:back",
  tabsForward: "once:tabs:forward",
  tabsReload: "once:tabs:reload",
  tabsStop: "once:tabs:stop",
  tabsDuplicate: "once:tabs:duplicate",
  tabsReorder: "once:tabs:reorder",
  tabsMoveHere: "once:tabs:move-here",
  tabsDetach: "once:tabs:detach",
  tabsToggleMuted: "once:tabs:toggle-muted",
  tabsOpenDroppedUrls: "once:tabs:open-dropped-urls",
  tabsStartSourcePicker: "once:tabs:start-source-picker",
  tabsShowMenu: "once:tabs:show-menu",
  tabsSetBounds: "once:tabs:set-bounds",
  tabsRestoreClosed: "once:tabs:restore-closed",
  tabsFocusContent: "once:tabs:focus-content",
  tabsChanged: "once:tabs:changed",
  tabsRegenerateReader: "once:tabs:regenerate-reader",
  storyMenuShow: "once:story-menu:show",
  storyMenuOpenExternal: "once:story-menu:open-external",
  storyMenuOpenWindow: "once:story-menu:open-window",
  windowSetFullscreen: "once:window:set-fullscreen",
  windowCreate: "once:window:create",
  windowFocusShell: "once:window:focus-shell",
  windowSetForwardedKeys: "once:window:set-forwarded-keys",
  windowKeyCommand: "once:window:key-command",
  windowNativeFocusChanged: "once:window:native-focus-changed",
  windowSetRedirects: "once:window:set-redirects",
  windowSetBackgroundColor: "once:window:set-background-color",
  windowTargetUrlChanged: "once:window:target-url-changed",
  windowFullscreenChanged: "once:window:fullscreen-changed",
  extensionsList: "once:extensions:list",
  extensionsOpenPopup: "once:extensions:open-popup",
  extensionsChanged: "once:extensions:changed",
  extensionsApplySettings: "once:extensions:apply-settings",
  extensionsSettingsAdopted: "once:extensions:settings-adopted",
  addonsDevList: "once:addons:dev-list",
  addonsDevChanged: "once:addons:dev-changed",
  addonsPickDirectory: "once:addons:pick-directory",
  addonsRemoveDirectory: "once:addons:remove-directory"
} as const

/** One `ONCE_ADDONS` directory as main read it; the renderer validates the manifest. */
export interface ElectronDevAddon {
  removable?: boolean
  directory: string
  manifest: unknown
  code: string | null
  error?: string
}

declare global {
  interface Window {
    onceElectron: ElectronBridge
  }
}
