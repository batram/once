import { Redirect, Story } from "@once/core"
import { SwipeSettings } from "./swipeSettings"

export type ThemeName = "system" | "light" | "dark"
export type AnimationSetting = boolean

export interface ProcessingSource {
  domain: string
  parserType: string
}

export interface SourceError {
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
  getStorySources(): Promise<string[]>
  saveStorySources(storySources: string[]): Promise<void>
  getFilterList(): Promise<string[]>
  saveFilterList(filterList: string[]): Promise<void>
  getRedirectList(): Promise<Redirect[]>
  saveRedirectList(redirectList: Redirect[]): Promise<void>
  getSyncUrl(): Promise<string>
  setSyncUrl(syncUrl: string): Promise<void>
  getCacheTime(): Promise<number>
  setCacheTime(cacheTime: string): Promise<void>
  getTheme(): Promise<ThemeName>
  setTheme(theme: ThemeName): Promise<void>
  getAnimation(): Promise<AnimationSetting>
  setAnimation(animated: AnimationSetting): Promise<void>
  getSwipeSettings(): Promise<SwipeSettings>
  setSwipeSettings(settings: SwipeSettings): Promise<void>
  reloadStories(tryCache?: boolean): Promise<void>
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
  fetchDocument(url: string): Promise<{ html: string; url: string }>
  openUrl(url: string, target: "_self" | "middle" | "blank" | string): void
  selectUrl(url: string): Promise<void>
  subscribe<T extends OnceEventName>(
    event: T,
    handler: OnceEventHandler<T>
  ): () => void
}

export interface ListStorePort {
  get<T>(id: string, fallbackValue: T): Promise<T>
  set<T>(id: string, value: T): Promise<void>
}

export interface StoryStorePort {
  storyId(url: string): string
  getStories(limit?: number): Promise<Story[]>
  getStoriesByUrls(urls: string[]): Promise<Map<string, Story>>
  getStory(url: string): Promise<Story | null>
  saveStory(story: Story): Promise<Story>
  deleteStory(url: string): Promise<void>
  onDiagnostic?(handler: (error: DiagnosticError) => void): () => void
}

export interface SyncServicePort {
  syncFrom(couchdbUrl: string): void
  onDiagnostic?(handler: (error: DiagnosticError) => void): () => void
  onStatus?(handler: (status: SyncStatus) => void): () => void
  onRemoteChange?(handler: (change: DatabaseChange) => void): () => void
}

export interface CacheStorePort {
  get(url: string): Promise<unknown>
  set(url: string, content: unknown): Promise<void>
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
  openUrl(url: string, target: "_self" | "middle" | "blank" | string): void
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
