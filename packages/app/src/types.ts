import { Redirect, Story, StorySourceDocument } from "@once/core"
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
  }
  /** Something changed what the cache holds: a reload, a refetch, a clear. */
  cacheStatusChanged: Record<string, never>
  redirectsChanged: {
    redirects: Redirect[]
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
  getSyncUrl(): Promise<string>
  setSyncUrl(syncUrl: string): Promise<void>
  getCacheTime(): Promise<number>
  setCacheTime(cacheTime: string): Promise<void>
  getCacheTiming(): Promise<CacheTimingDocument>
  setCacheTiming(timing: CacheTimingDocument): Promise<void>
  getTheme(): Promise<ThemeName>
  setTheme(theme: ThemeName): Promise<void>
  getAnimation(): Promise<AnimationSetting>
  setAnimation(animated: AnimationSetting): Promise<void>
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
    value: Story | string | boolean
  ): Promise<Story | undefined>
  purgeStory(href: string): Promise<void>
  addFilter(filter: string): Promise<void>
  fetchDocument(url: string): Promise<{
    html: string
    url: string
    mediaType: string
  }>
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
  saveStory(story: Story): Promise<Story>
  deleteStory(url: string): Promise<void>
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
  theme: ThemePort
  activeTab?: ActiveTabPort
  fetch: typeof fetch
  onDatabaseChange?: (handler: (change: DatabaseChange) => void) => () => void
  onHistoryCommand?: (
    handler: (action: "undo" | "redo") => void
  ) => () => void
}
