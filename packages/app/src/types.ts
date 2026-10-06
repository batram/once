import type { StoryPageContext } from "@once/core"
import {
  AddonsDocument,
  FilterListsDocument,
  Redirect,
  StoredContentMeta,
  Story,
  StorySourceDocument,
  StoryTag,
  UserscriptsDocument,
  VaultStorePort
} from "@once/core"
import { CacheTimingDocument } from "./cacheTiming"
import { SwipeSettings } from "./swipeSettings"

export type ThemeName = "system" | "light" | "dark"
export type AnimationSetting = boolean

/**
 * What a load is allowed to do about the cache. Named rather than boolean
 * because "true" read as both "prefer the cache" and "the cache is valid" at
 * different call sites, and only one of those is the caller's to decide.
 */
export type CachePolicy = "cache-first" | "network-only"

export interface ProcessingSource {
  domain: string
  parserType: string
}

export interface SourceError {
  sourceId: string
  url: string
  title: string
  message: string
  type: "warning" | "error"
  details?: string
}

export interface DiagnosticError {
  severity: "warning" | "error"
  operation: string
  message: string
  details?: string
  sourceUrl?: string
  storyUrl?: string
  documentId?: string
}

export interface SyncStatus {
  state:
    | "disabled"
    | "connecting"
    | "syncing"
    | "up-to-date"
    | "retrying"
    | "error"
  message: string
  changes?: number
}

/** What one story field may be set to through the client. */
export type StoryChangeValue = Story | string | boolean | StoryTag[]

export interface StoredStoryContent {
  html: string
  meta: StoredContentMeta
}

export interface StoryChangeDetail {
  story: Story
  path: string[] | string
  value: unknown
  previousValue: unknown
  name: string | null
  animated: boolean
}

export interface OnceAppEvents {
  diagnosticError: DiagnosticError
  syncStatusChanged: SyncStatus
  /** Tab sync options, this device or another device's tabs changed. */
  tabSyncChanged: Record<string, never>
  loaderChanged: {
    processing: ProcessingSource[]
    visible: boolean
  }
  sourceErrorsChanged: {
    errors: SourceError[]
  }
  storiesChanged: {
    stories: Story[]
    bucket: string
    replace?: boolean
  }
  storyChanged: StoryChangeDetail
  storyRemoved: {
    href: string
  }
  settingsChanged: {
    section:
      | "sources"
      | "filters"
      | "redirects"
      | "theme"
      | "animation"
      | "cache"
      | "sync"
      | "swipe"
      | "extensions"
      | "addons"
      | "content"
  }
  /** Something changed what the cache holds: a reload, a refetch, a clear. */
  cacheStatusChanged: Record<string, never>
  /**
   * A story whose article should be fetched and stored: a bookmarked story
   * under the bookmark setting, or a new story from a source that asked for
   * it. The app decides which; whoever has a DOM fetches and extracts.
   */
  storyContentRequested: {
    href: string
  }
  redirectsChanged: {
    redirects: Redirect[]
  }
  /** The filter-list and userscript documents, for whatever runs them here. */
  extensionSettingsChanged: {
    filterLists: FilterListsDocument
    userscripts: UserscriptsDocument
  }
  menuChanged: {
    groups: string[]
    types: string[]
  }
  selectedUrlChanged: {
    url: string
    context?: StoryPageContext
  }
  historyCommand: {
    action: "undo" | "redo"
  }
  searchRequested: {
    query: string
  }
}

export type OnceEventName = keyof OnceAppEvents
export type OnceEventHandler<T extends OnceEventName> = (
  payload: OnceAppEvents[T]
) => void

export interface OnceClient {
  getAddonVaultStatus(): Promise<import("@once/core").AddonVaultStatus>
  /** Installs a snapshot of a linked folder; `replace` updates an installed copy with the same ID instead of refusing. */
  shareAddonSnapshot(entry: import("@once/core").AddonEntry, code: string | null, replace?: boolean): Promise<void>
  createAddonVault(passphrase: string, remember: boolean, deviceName: string): Promise<{ recoveryKey: string; warning?: string }>
  unlockAddonVault(secret: string, recovery: boolean, remember: boolean, deviceName: string): Promise<void>
  lockAddonVault(): Promise<void>
  changeAddonVaultPassphrase(passphrase: string): Promise<void>
  getAddonVaultChoices(): Promise<import("@once/core").AddonVaultChoice[]>
  resolveAddonVault(revision: string, expected: string[]): Promise<void>
  getDiagnostics(): DiagnosticError[]
  getSyncStatus(): SyncStatus
  getStorySources(): Promise<StorySourceDocument>
  saveStorySources(
    storySources: StorySourceDocument,
    reloadStories?: boolean
  ): Promise<void>
  getFilterList(): Promise<string[]>
  saveFilterList(filterList: string[]): Promise<void>
  getRedirectList(): Promise<Redirect[]>
  saveRedirectList(redirectList: Redirect[]): Promise<void>
  getBrowserExtensionSync(): Promise<import("@once/core").BrowserExtensionSyncDocument>
  updateBrowserExtensionSync(change: (document: import("@once/core").BrowserExtensionSyncDocument) => import("@once/core").BrowserExtensionSyncDocument): Promise<void>
  saveBrowserExtensionSync(document: import("@once/core").BrowserExtensionSyncDocument): Promise<void>
  getFilterLists(): Promise<FilterListsDocument>
  saveFilterLists(document: FilterListsDocument): Promise<void>
  getAddons(): Promise<AddonsDocument>
  saveAddons(document: AddonsDocument): Promise<void>
  updateAddons(change: (document: AddonsDocument) => AddonsDocument): Promise<void>
  getUserscripts(): Promise<UserscriptsDocument>
  saveUserscripts(document: UserscriptsDocument): Promise<void>
  getSyncUrl(): Promise<string>
  setSyncUrl(syncUrl: string): Promise<void>
  /** Whether this client must ask before sending data to the sync server, and whether it has. */
  getSyncConsent(): Promise<"not-needed" | "required" | "granted">
  /** Shows the browser's consent prompt; call it directly from a user gesture. */
  requestSyncConsent(): Promise<boolean>
  /** This device, its tab sync options and other devices' tabs; null where tab sync is unavailable. */
  getTabSync(): Promise<import("./tabsync/TabSyncService").TabSyncView | null>
  setTabSyncOptions(change: Partial<import("@once/core").TabSyncOptions>): Promise<void>
  setTabSyncShared(change: Partial<import("@once/core").TabSyncSharedSettings>): Promise<void>
  /** The name other devices and add-on sync snapshots show for this one. */
  renameDevice(name: string): Promise<void>
  /** Another device's tab screenshot as a data URL, or null while it has not arrived. */
  getTabThumbnail(id: string): Promise<string | null>
  /** Opens another device's tab here, in a new tab; never replaces the page being read. */
  openRemoteTab(url: string, mode: "web" | "reader", background: boolean,
    state?: Record<string, import("@once/core").TabStateEntry>): void
  /** Sends a tab (another device's, from a list) to a device, which lists it until opened. */
  sendTab(deviceId: string, tab: { url: string; title: string; mode: "web" | "reader";
    state?: Record<string, import("@once/core").TabStateEntry> }): Promise<void>
  /** Sends one of this device's tabs, by its id here, with where it was left. */
  sendLocalTab(deviceId: string, tabId: string): Promise<void>
  /** Opens a tab sent here where it was left, and takes it out of the inbox. */
  openSentTab(id: string, background: boolean): Promise<void>
  dismissSentTab(id: string): Promise<void>
  /** Removes another device from tab sync until it turns sharing on again. */
  forgetDevice(deviceId: string): Promise<void>
  resetDeviceIdentity(): Promise<void>
  /**
   * The token a source sends, kept on this device only. Absent reads as "";
   * setting "" removes it. Rejects when this shell has no secret store.
   */
  getSourceSecret(sourceId: string): Promise<string>
  setSourceSecret(sourceId: string, secret: string): Promise<void>
  saveAddonSecret(addon: string, field: string, endpoint: string, secret: string, localOnly?: boolean): Promise<void>
  hasAddonSecret(addon: string, field: string, endpoint: string, localOnly?: boolean): Promise<boolean>
  requestAddonConnection(manifest: import("@once/core").AddonManifest, options: Record<string, unknown>, connection: string,
    request: import("@once/core").AddonRequest, signal?: AbortSignal, localOnly?: boolean,
    onChunk?: (text: string) => void): Promise<import("@once/core").AddonResponse>
  getCacheTime(): Promise<number>
  setCacheTime(cacheTime: string): Promise<void>
  getCacheTiming(): Promise<CacheTimingDocument>
  setCacheTiming(timing: CacheTimingDocument): Promise<void>
  getTheme(): Promise<ThemeName>
  setTheme(theme: ThemeName): Promise<void>
  getAnimation(): Promise<AnimationSetting>
  setAnimation(animated: AnimationSetting): Promise<void>
  /** Whether bookmarking a story also stores its article for offline reading. */
  getSaveBookmarkedContent(): Promise<boolean>
  setSaveBookmarkedContent(enabled: boolean): Promise<void>
  getSwipeSettings(): Promise<SwipeSettings>
  setSwipeSettings(settings: SwipeSettings): Promise<void>
  reloadStories(policy?: CachePolicy): Promise<void>
  /**
   * Refetches one source, ignoring its window. It never deletes the cached
   * body first: another source may share the URL, and the fetch replaces the
   * entry anyway.
   */
  refetchSource(sourceId: string): Promise<void>
  getSourceCacheStatus(): Promise<SourceCacheStatus[]>
  clearCachedFeeds(): Promise<void>
  getStories(): Promise<Story[]>
  getStorySnapshot(): Story[]
  findStoryByUrl(url: string): Promise<Story | null>
  settledStoryWrites(): Promise<void>
  persistStoryChange(
    href: string,
    path: string,
    value: StoryChangeValue
  ): Promise<Story | undefined>
  purgeStory(href: string): Promise<void>
  /** The stored article of a story, with what is known about it, or null. */
  getStoryContent(href: string): Promise<StoredStoryContent | null>
  /**
   * Stores an article for a story and announces it as a `stored_content`
   * change, so rows and readers pick it up.
   */
  saveStoryContent(
    href: string,
    html: string,
    meta: Omit<StoredContentMeta, "saved_at"> & { saved_at?: number }
  ): Promise<Story | undefined>
  addFilter(filter: string): Promise<void>
  fetchDocument(url: string): Promise<{
    html: string
    url: string
    mediaType: string
  }>
  /** A small http(s) text resource through the platform's fetch: add-on code. */
  fetchText(url: string): Promise<string>
  /**
   * Add-on code kept on this device only, keyed by its integrity hash, so an
   * add-on synced from elsewhere still runs offline once it was fetched here.
   */
  getAddonScript(integrity: string): Promise<string | null>
  storeAddonScript(integrity: string, code: string): Promise<void>
  /** See ActiveTabPort.openUrl for what the targets mean. */
  openUrl(
    url: string,
    target: "_self" | "current" | "middle" | "blank" | string
  ): void
  selectUrl(url: string, context?: StoryPageContext): Promise<void>
  subscribe<T extends OnceEventName>(
    event: T,
    handler: OnceEventHandler<T>
  ): () => void
}

/** One source's cache position, for the settings rows that report on it. */
export interface SourceCacheStatus {
  sourceId: string
  /** What the user calls it: its label, or the host it fetches from. */
  name: string
  /** The URL the body is cached under, which two sources can share. */
  url: string
  collectorId?: string
  cacheMinutes: number
  /** False when the window comes from a collector or the global default. */
  ownWindow: boolean
  /** When the cached body was fetched; absent means nothing is cached. */
  fetchedAt?: number
}

export interface ListStorePort {
  readVault?: VaultStorePort["readVault"]
  writeVault?: VaultStorePort["writeVault"]
  get<T>(id: string, fallbackValue: T): Promise<T>
  set<T>(id: string, value: T): Promise<void>
}

export interface StoryStorePort {
  storyId(url: string): string
  getStories(limit?: number): Promise<Story[]>
  getStaredStories(): Promise<Story[]>
  getStoriesByUrls(urls: string[]): Promise<Map<string, Story>>
  getStory(url: string): Promise<Story | null>
  /**
   * Writes the story; html the story carries through `attachContent` becomes
   * its `content` attachment and is dropped from the returned story.
   */
  saveStory(story: Story): Promise<Story>
  deleteStory(url: string): Promise<void>
  /** The stored article html, or null when the story has none. */
  getStoryContent(url: string): Promise<string | null>
  onDiagnostic?(handler: (error: DiagnosticError) => void): () => void
}

export interface SyncServicePort {
  syncFrom(couchdbUrl: string, getLoadedStoryIds?: () => string[]): void
  onSettingsReplicated?(handler: () => void): () => void
  onDiagnostic?(handler: (error: DiagnosticError) => void): () => void
  onStatus?(handler: (status: SyncStatus) => void): () => void
  onRemoteChange?(handler: (change: DatabaseChange) => void): () => void
  /** Pulled tab sync documents (`dev_`, `tsend_`, `tret_`), deletions included. */
  onRemoteTabChange?(handler: (change: DatabaseChange) => void): () => void
  /** Whether the local database holds any documents, which an earlier connection may have brought. */
  hasLocalData?(): Promise<boolean>
}

export interface CacheStorePort {
  get(url: string): Promise<unknown>
  set(url: string, content: unknown): Promise<void>
  /** Removes one entry. Keyed on the fetched URL, like everything else here. */
  delete(url: string): Promise<void>
  /** Removes every cached feed body, and nothing else the store may hold. */
  clear(): Promise<void>
}

export interface SyncSettingsStorePort {
  getSyncUrl(): Promise<string>
  setSyncUrl(syncUrl: string): Promise<void>
  /** The URL changed elsewhere: another window, or the browser's own settings sync. */
  onSyncUrlChanged?(handler: () => void): () => void
  getCacheTime(): Promise<number>
  setCacheTime(cacheTime: string): Promise<void>
}

/**
 * Secrets that stay on this device: source tokens. Kept beside the sync URL
 * rather than in the synced settings, which travel in the clear. An absent
 * value reads as the empty string; setting the empty string removes it.
 */
export interface SecretStorePort {
  /** Only native keychain/OS-protected stores opt into remembering keys by default. */
  protection?: "os"
  get(key: string): Promise<string>
  set(key: string, value: string): Promise<void>
  /** Another context of this device changed a value. */
  onChanged?(handler: () => void): () => void
}

/**
 * Consent to send data to the sync server, where the browser asks for it
 * (Firefox's data collection permissions). Without this port no consent is
 * needed. `request` must be called directly from a user gesture.
 */
export interface SyncConsentPort {
  granted(): Promise<boolean>
  /** False when this browser cannot ask at all; sync then stays off. */
  supported?(): Promise<boolean>
  request(): Promise<boolean>
  onChanged(handler: () => void): () => void
}

/**
 * The few document operations tab sync needs, so the same logic runs on the
 * local PouchDB and, in an extension background, on CouchDB over HTTP.
 * `get` resolves null for a missing or deleted document.
 */
export interface TabDocDatabase {
  /** `attachments` inlines attachment bodies as base64 `data`. */
  get(id: string, options?: { conflicts?: boolean; rev?: string; attachments?: boolean }): Promise<Record<string, unknown> | null>
  put(doc: Record<string, unknown>): Promise<{ rev: string }>
  remove(id: string, rev: string): Promise<void>
  /** Every live document whose id starts with `prefix`, with its `_conflicts`. */
  list(prefix: string): Promise<Array<Record<string, unknown>>>
}

/** One open tab as this device sees it, before filtering for publication. */
export interface LocalTab {
  id: string
  navSeq: number
  url: string
  title: string
  mode: "web" | "reader"
  active: boolean
  pinned?: boolean
  audible?: boolean
  openedAt: number
  navigatedAt: number
  selectedAt: number
  activityAt: number
  storyId?: string
}

export interface LocalWindow {
  id: string
  focused: boolean
  /** Private windows are never published. */
  incognito?: boolean
  tabs: LocalTab[]
}

/**
 * A self-contained function to run inside a page, with JSON arguments; see
 * tabsync/pageScripts. Platforms run it as source text or hand the function
 * to their scripting API.
 */
export interface PageScriptCall<A extends unknown[] = unknown[], R = unknown> {
  /** Any function: each call names its own argument types. */
  fn: (...args: never[]) => R
  args: A
}

/** Serializes a page script call for platforms that run source text. */
export function pageScriptSource(call: PageScriptCall): string {
  return `(${call.fn.toString()})(...${JSON.stringify(call.args)})`
}

/** Opens a page in a new tab of this shell, for tabs that come from other devices. */
export interface TabOpenerPort {
  /**
   * `restore` runs in the opened page once it has loaded; `readerPosition`
   * is where a Reader-mode tab continues, for readers a script cannot reach.
   */
  open(url: string, options: {
    background: boolean
    mode: "web" | "reader"
    restore?: PageScriptCall
    readerPosition?: import("@once/core").ReaderPosition
  }): void
}

/** A small JPEG of a tab, base64 without a data URL prefix. */
export interface TabThumbnail { jpeg: string; width: number; height: number }

/** This device's open tabs, for the platforms that publish them. */
export interface TabSourcePort {
  snapshot(): Promise<LocalWindow[]>
  onChanged(handler: () => void): () => void
  /**
   * A screenshot of the tab as it shows now, or null when the platform
   * cannot take one (e.g. a browser can only capture each window's visible tab).
   */
  captureThumbnail?(tabId: string): Promise<TabThumbnail | null>
  /** Runs a page script in a tab's page; null when the tab cannot be scripted now. */
  runInPage?<R>(tabId: string, call: PageScriptCall<unknown[], R>): Promise<R | null>
  /** How far a Reader-mode tab was read, for readers a page script cannot reach. */
  readerPosition?(tabId: string): Promise<import("@once/core").ReaderPosition | null>
  /** A tab stopped being the selected one: the moment to read where it was left. */
  onDeselected?(handler: (tabId: string) => void): () => void
}

export interface ThemePort {
  setTheme(theme: ThemeName): void
}

export interface ActiveTabPort {
  /**
   * `target` is a link target with two additions. "_self" means "wherever this
   * shell shows a story" — a new foreground tab, in Electron and in the
   * extensions alike, so the page being read is never replaced. "current"
   * means "replace the page the user is looking at", in place.
   */
  openUrl(
    url: string,
    target: "_self" | "current" | "middle" | "blank" | string
  ): void
  onSelectedUrlChanged(handler: (url: string, context?: StoryPageContext) => void): () => void
}

export interface DatabaseChange {
  id: string
  doc?: Record<string, unknown>
  presentation?: "foreground" | "background"
}

export interface OncePlatformPorts {
  listStore: ListStorePort
  storyStore: StoryStorePort
  syncService?: SyncServicePort
  cacheStore?: CacheStorePort
  syncSettingsStore: SyncSettingsStorePort
  /**
   * "browser" when the sync URL arrives through the browser's settings sync
   * from other installations; such a URL is not proof of where this profile's
   * data came from. Defaults to "device".
   */
  syncUrlProvenance?: "device" | "browser"
  syncConsent?: SyncConsentPort
  /** Tab sync documents in the local database; without it tab sync is unavailable. */
  tabDocs?: TabDocDatabase
  /** This device's tabs; without it the device can view other devices' tabs but not share its own. */
  tabSource?: TabSourcePort
  /** Where another device's tab opens; without it a new foreground or background tab via `activeTab`. */
  tabOpener?: TabOpenerPort
  /** What this device is to the others; required for tab sync. */
  device?: {
    platform: import("@once/core").TabSyncPlatform
    defaultName: string
    appVersion: string
    /** This device's tabs are published by another context, e.g. an extension's background. */
    sharesElsewhere?: boolean
  }
  /** Without one, sources that need a token report that they cannot have one. */
  secretStore?: SecretStorePort
  theme: ThemePort
  activeTab?: ActiveTabPort
  fetch: typeof fetch
  /** Optional transport for addon connections with explicit redirect/cookie controls. */
  addonFetch?: typeof fetch
  onDatabaseChange?: (handler: (change: DatabaseChange) => void) => () => void
  onHistoryCommand?: (
    handler: (action: "undo" | "redo") => void
  ) => () => void
}
