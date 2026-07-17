import { Redirect, Story } from "@once/core"

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
  settingsChanged: {
    section:
      | "sources"
      | "filters"
      | "redirects"
      | "theme"
      | "animation"
      | "cache"
      | "sync"
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
  reloadStories(tryCache?: boolean): Promise<void>
  getStories(): Promise<Story[]>
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
  getStories(): Promise<Story[]>
  getStory(url: string): Promise<Story | null>
  saveStory(story: Story): Promise<Story>
  deleteStory(url: string): Promise<void>
}

export interface SyncServicePort {
  syncFrom(couchdbUrl: string): void
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
