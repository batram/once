import {
  AddonsDocument,
  FilterListsDocument,
  Redirect,
  StoredContentMeta,
  Story,
  StorySourceDocument,
  StoryTag,
  UserscriptsDocument
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
  getFilterLists(): Promise<FilterListsDocument>
  saveFilterLists(document: FilterListsDocument): Promise<void>
  getAddons(): Promise<AddonsDocument>
  saveAddons(document: AddonsDocument): Promise<void>
  updateAddons(change: (document: AddonsDocument) => AddonsDocument): Promise<void>
  getUserscripts(): Promise<UserscriptsDocument>
  saveUserscripts(document: UserscriptsDocument): Promise<void>
  getSyncUrl(): Promise<string>
  setSyncUrl(syncUrl: string): Promise<void>
  /**
   * The token a source sends, kept on this device only. Absent reads as "";
   * setting "" removes it. Rejects when this shell has no secret store.
   */
  getSourceSecret(sourceId: string): Promise<string>
  setSourceSecret(sourceId: string, secret: string): Promise<void>
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
  selectUrl(url: string): Promise<void>
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
  getCacheTime(): Promise<number>
  setCacheTime(cacheTime: string): Promise<void>
}

/**
 * Secrets that stay on this device: source tokens. Kept beside the sync URL
 * rather than in the synced settings, which travel in the clear. An absent
 * value reads as the empty string; setting the empty string removes it.
 */
export interface SecretStorePort {
  get(key: string): Promise<string>
  set(key: string, value: string): Promise<void>
}

export interface ThemePort {
  setTheme(theme: ThemeName): void
}

export interface ActiveTabPort {
  /**
   * `target` is a link target with two additions. "_self" means "wherever this
   * shell shows a story" — the Electron content pane, a new tab in the
   * extensions, since the panel is not one. "current" means "replace the page
   * the user is looking at", which is a different thing in the extensions and
   * the same thing in Electron.
   */
  openUrl(
    url: string,
    target: "_self" | "current" | "middle" | "blank" | string
  ): void
  onSelectedUrlChanged(handler: (url: string) => void): () => void
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
  /** Without one, sources that need a token report that they cannot have one. */
  secretStore?: SecretStorePort
  theme: ThemePort
  activeTab?: ActiveTabPort
  fetch: typeof fetch
  onDatabaseChange?: (handler: (change: DatabaseChange) => void) => () => void
  onHistoryCommand?: (
    handler: (action: "undo" | "redo") => void
  ) => () => void
}
