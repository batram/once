import { BrowserExtensionSyncDocument, BROWSER_EXTENSION_SYNC_ID, readBrowserExtensionSync } from "@once/core"
import {
  ADDONS_DOCUMENT_ID,
  AddonsDocument,
  DEFAULT_CACHE_MINUTES,
  defaultFilterList,
  defaultRedirectList,
  defaultStorySources,
  FILTER_LISTS_DOCUMENT_ID,
  FilterListsDocument,
  normalizeSyncUrl,
  parseStorySources,
  readAddonsDocument,
  readFilterListsDocument,
  readUserscriptsDocument,
  StorySourceDocument,
  Redirect,
  USERSCRIPTS_DOCUMENT_ID,
  UserscriptsDocument
} from "@once/core"
import {
  AnimationSetting,
  DatabaseChange,
  DiagnosticError,
  ListStorePort,
  SyncServicePort,
  SyncSettingsStorePort,
  ThemeName,
  ThemePort
} from "./types"
import {
  CACHE_TIMING_DOCUMENT_ID,
  CACHE_TIMING_VERSION,
  CacheTimedSource,
  CacheTimingDocument,
  effectiveCacheMinutes,
  readCacheTimingDocument
} from "./cacheTiming"
import {
  DEFAULT_SWIPE_SETTINGS,
  normalizeSwipeSettings,
  SwipeSettings
} from "./swipeSettings"

type SettingsSection =
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

export const SAVE_BOOKMARKED_CONTENT_ID = "save_bookmarked_content"

export interface AppSettingsActions {
  publishChanged(section: SettingsSection): void
  reportDiagnostic(error: DiagnosticError): void
  reloadStories(): Promise<void> | void
  refilterStories(): Promise<void> | void
  refreshRedirects(): Promise<void> | void
  refreshExtensionSettings(): Promise<void> | void
  updateSourceMenu(sources: StorySourceDocument): void
  /** Drops what sources present in `previous` but gone from `current` cached. */
  evictRemovedSources(
    previous: StorySourceDocument,
    current: StorySourceDocument
  ): Promise<void> | void
  loadedStoryIds(): string[]
  /**
   * Null when `url` may be used for sync now, otherwise why not. Runs before
   * every transport start: the destination binding and data consent.
   */
  authorizeSync(url: string, origin: SyncStartOrigin): Promise<string | null>
  /** Shows why sync is not running, or clears that once it runs again. */
  reportSyncBlocked(message: string | null): void
}

/** Who asked for a connection: decides whether a URL counts as the user's choice. */
export type SyncStartOrigin = "startup" | "user" | "external"

export class AppSettings {
  private addonWrites: Promise<void> = Promise.resolve()
  private browserExtensionWrites: Promise<void> = Promise.resolve()
  private readonly pendingWrites = new Map<string, string>()
  private sourcesState: "pending" | "resolved" = "pending"
  private sourcesDocument?: StorySourceDocument
  private localSourcesResolution?: Promise<void>
  private connectionGeneration = 0
  private syncBlocked = false
  animated: AnimationSetting = true

  constructor(
    private readonly listStore: ListStorePort,
    private readonly syncStore: SyncSettingsStorePort,
    private readonly syncService: SyncServicePort | undefined,
    private readonly theme: ThemePort,
    private readonly actions: AppSettingsActions
  ) {
    this.syncService?.onSettingsReplicated?.(() => {
      void this.resolveStorySources(true)
    })
  }

  async getStorySources(): Promise<StorySourceDocument> {
    if (this.sourcesState === "pending" && this.localSourcesResolution) {
      await this.localSourcesResolution
    }
    if (this.sourcesState === "resolved" && this.sourcesDocument) {
      return structuredClone(this.sourcesDocument)
    }
    return structuredClone(this.sourcesDocument ?? defaultStorySources)
  }

  async saveStorySources(sources: StorySourceDocument, reload = true): Promise<void> {
    const parsed = parseStorySources(sources)
    if (!parsed.ok) {
      throw new Error(parsed.reports.map((item) => `${item.path}: ${item.message}`).join("\n"))
    }
    await this.setList("sources", parsed.doc)
    const previous = this.sourcesDocument
    this.sourcesDocument = parsed.doc
    this.sourcesState = "resolved"
    // A deleted source leaves its body behind otherwise, and nothing else ever
    // asks for that URL again.
    if (previous) await this.actions.evictRemovedSources(previous, parsed.doc)
    this.actions.updateSourceMenu(parsed.doc)
    this.actions.publishChanged("sources")
    if (reload) await this.actions.reloadStories()
  }

  getFilterList(): Promise<string[]> {
    return this.getList("filter_list", defaultFilterList)
  }

  async saveFilterList(filters: string[]): Promise<void> {
    await this.setList("filter_list", filters)
    this.actions.publishChanged("filters")
    await this.actions.refilterStories()
  }

  getRedirectList(): Promise<Redirect[]> {
    return this.getList("redirect_list", defaultRedirectList)
  }

  async saveRedirectList(redirects: Redirect[]): Promise<void> {
    await this.setList("redirect_list", redirects)
    await this.actions.refreshRedirects()
    this.actions.publishChanged("redirects")
  }

  // Both documents are read tolerantly and written normalized, like cache
  // timing: another client may have written them with a newer build.
  async getBrowserExtensionSync(): Promise<BrowserExtensionSyncDocument> {
    return readBrowserExtensionSync(await this.getList<unknown>(BROWSER_EXTENSION_SYNC_ID, null))
  }

  async saveBrowserExtensionSync(document: BrowserExtensionSyncDocument): Promise<void> {
    await this.updateBrowserExtensionSync(() => document)
  }

  updateBrowserExtensionSync(change: (document: BrowserExtensionSyncDocument) => BrowserExtensionSyncDocument): Promise<void> {
    const work = this.browserExtensionWrites.then(async () => {
      const previous = await this.getBrowserExtensionSync()
      const before = JSON.stringify(previous)
      const next = readBrowserExtensionSync(change(previous))
      if (JSON.stringify(next) === before) return
      await this.setList(BROWSER_EXTENSION_SYNC_ID, next)
      this.actions.publishChanged("extensions")
    })
    this.browserExtensionWrites = work.catch(() => undefined)
    return work
  }

  async getFilterLists(): Promise<FilterListsDocument> {
    return readFilterListsDocument(await this.getList<unknown>(FILTER_LISTS_DOCUMENT_ID, null))
  }

  async saveFilterLists(document: FilterListsDocument): Promise<void> {
    await this.setList(FILTER_LISTS_DOCUMENT_ID, readFilterListsDocument(document))
    await this.actions.refreshExtensionSettings()
    this.actions.publishChanged("extensions")
  }

  async getUserscripts(): Promise<UserscriptsDocument> {
    return readUserscriptsDocument(await this.getList<unknown>(USERSCRIPTS_DOCUMENT_ID, null))
  }

  async saveUserscripts(document: UserscriptsDocument): Promise<void> {
    await this.setList(USERSCRIPTS_DOCUMENT_ID, readUserscriptsDocument(document))
    await this.actions.refreshExtensionSettings()
    this.actions.publishChanged("extensions")
  }

  /** The installed add-ons: manifests plus enabled flags, validated on read. */
  async getAddons(): Promise<AddonsDocument> {
    return readAddonsDocument(await this.getList<unknown>(ADDONS_DOCUMENT_ID, null))
  }

  async saveAddons(document: AddonsDocument): Promise<void> {
    await this.updateAddons(() => document)
  }

  updateAddons(change: (document: AddonsDocument) => AddonsDocument): Promise<void> {
    const work = this.addonWrites.then(async () => {
      const previous = await this.getAddons()
      const next = readAddonsDocument(change(previous))
      if (JSON.stringify(previous) === JSON.stringify(next)) return
      await this.setList(ADDONS_DOCUMENT_ID, next)
      this.actions.publishChanged("addons")
    })
    this.addonWrites = work.catch(() => undefined)
    return work
  }

  async getSyncUrl(): Promise<string> {
    try {
      return await this.syncStore.getSyncUrl()
    } catch (error) {
      this.reportLoadError("sync", error)
      return ""
    }
  }

  async setSyncUrl(syncUrl: string): Promise<void> {
    let normalizedUrl: string
    try {
      normalizedUrl = normalizeSyncUrl(syncUrl)
    } catch (error) {
      this.reportSaveError(
        "settings.save.sync",
        "The CouchDB URL is invalid",
        error
      )
      throw error
    }
    const changed = normalizedUrl !== await this.getSyncUrl()
    if (changed || this.syncBlocked) {
      // Refuse before saving, so a URL this profile may not use never
      // replaces the one it may.
      const refusal = normalizedUrl ? await this.actions.authorizeSync(normalizedUrl, "user") : null
      if (refusal) throw new Error(refusal)
      if (changed) {
        try {
          await this.syncStore.setSyncUrl(normalizedUrl)
        } catch (error) {
          this.reportSaveError(
            "settings.save.sync",
            "The sync setting could not be saved",
            error
          )
          throw error
        }
      }
      await this.startSync(normalizedUrl, "user")
    }
    this.actions.publishChanged("sync")
  }

  /**
   * (Re)starts replication with `syncUrl`, after the gate allows it. A newer
   * call supersedes one still waiting on the gate, so a URL replaced in the
   * meantime is never connected to.
   */
  async startSync(syncUrl: string, origin: SyncStartOrigin = "startup"): Promise<void> {
    const generation = ++this.connectionGeneration
    // The stored sources answer from the start; the replicated settings
    // replace them later, or never do while offline. Only a local-only setup
    // writes the defaults: with sync, an absent document is the remote's to fill.
    this.localSourcesResolution ??= this.resolveStorySources(false, !syncUrl.trim())
    await this.localSourcesResolution
    if (generation !== this.connectionGeneration) return
    if (!syncUrl.trim()) {
      this.setSyncBlocked(null)
      this.syncService?.syncFrom("", () => this.actions.loadedStoryIds())
      return
    }
    // Cancel the current connection while the new one is checked: old
    // queued work must not continue against a URL being replaced.
    this.syncService?.syncFrom("", () => this.actions.loadedStoryIds())
    const refusal = await this.actions.authorizeSync(syncUrl, origin)
    if (generation !== this.connectionGeneration) return
    this.setSyncBlocked(refusal)
    if (refusal) return
    this.syncService?.syncFrom(syncUrl, () => this.actions.loadedStoryIds())
  }

  /** Stops replication without forgetting the URL, e.g. when consent is withdrawn. */
  async restartSync(origin: SyncStartOrigin): Promise<void> {
    await this.startSync(await this.getSyncUrl(), origin)
  }

  private setSyncBlocked(message: string | null): void {
    this.syncBlocked = message !== null
    this.actions.reportSyncBlocked(message)
  }

  async getCacheTime(): Promise<number> {
    try {
      return await this.syncStore.getCacheTime()
    } catch (error) {
      this.reportLoadError("cache", error)
      return DEFAULT_CACHE_MINUTES
    }
  }

  async setCacheTime(cacheTime: string): Promise<void> {
    if (parseInt(cacheTime) === await this.getCacheTime()) {
      this.actions.publishChanged("cache")
      return
    }
    try {
      await this.syncStore.setCacheTime(cacheTime)
    } catch (error) {
      this.reportSaveError(
        "settings.save.cache",
        "The cache setting could not be saved",
        error
      )
      throw error
    }
    this.actions.publishChanged("cache")
  }

  /**
   * The per-collector windows. Read tolerantly on every call rather than
   * cached: a reload pass reads it once anyway, and another client's write
   * arrives through the observed change below without a cache to invalidate.
   */
  async getCacheTiming(): Promise<CacheTimingDocument> {
    return readCacheTimingDocument(
      await this.getList<unknown>(CACHE_TIMING_DOCUMENT_ID, null)
    )
  }

  /**
   * The windows for one reload pass. Resolved from a single read of both the
   * timing document and the global default, so every source in the pass judges
   * its body against the same policy even if a write lands mid-fan-out.
   */
  async cacheWindows(): Promise<(source: CacheTimedSource) => number> {
    const [timing, globalMinutes] = await Promise.all([
      this.getCacheTiming(),
      this.getCacheTime()
    ])
    return (source) => effectiveCacheMinutes(source, timing, globalMinutes)
  }

  async setCacheTiming(timing: CacheTimingDocument): Promise<void> {
    await this.setList(
      CACHE_TIMING_DOCUMENT_ID,
      readCacheTimingDocument({ ...timing, version: CACHE_TIMING_VERSION })
    )
    this.actions.publishChanged("cache")
  }

  getTheme(): Promise<ThemeName> {
    return this.getList("theme", "dark" as ThemeName)
  }

  async setTheme(theme: ThemeName): Promise<void> {
    if (theme !== await this.getTheme()) await this.setList("theme", theme)
    this.theme.setTheme(theme)
    this.actions.publishChanged("theme")
  }

  getAnimation(): Promise<AnimationSetting> {
    return this.getList("animation", true)
  }

  async setAnimation(animated: AnimationSetting): Promise<void> {
    if (animated !== await this.getAnimation()) {
      await this.setList("animation", animated)
    }
    this.animated = animated
    this.actions.publishChanged("animation")
  }

  getSaveBookmarkedContent(): Promise<boolean> {
    return this.getList(SAVE_BOOKMARKED_CONTENT_ID, false)
  }

  async setSaveBookmarkedContent(enabled: boolean): Promise<void> {
    if (enabled !== await this.getSaveBookmarkedContent()) {
      await this.setList(SAVE_BOOKMARKED_CONTENT_ID, enabled)
    }
    this.actions.publishChanged("content")
  }

  async getSwipeSettings(): Promise<SwipeSettings> {
    return normalizeSwipeSettings(
      await this.getList<unknown>("swipe", DEFAULT_SWIPE_SETTINGS)
    )
  }

  async setSwipeSettings(settings: SwipeSettings): Promise<void> {
    await this.setList("swipe", normalizeSwipeSettings(settings))
    this.actions.publishChanged("swipe")
  }

  async addFilter(filter: string): Promise<void> {
    const filters = await this.getFilterList()
    filters.push(filter)
    await this.saveFilterList(filters)
  }

  handleObservedChange(change: DatabaseChange): void {
    const pending = this.pendingWrites.get(change.id)
    if (pending !== undefined && JSON.stringify(change.doc?.list) === pending) {
      this.pendingWrites.delete(change.id)
      return
    }
    switch (change.id) {
      case "sources":
        // Initial replication writes pulled documents into the live local
        // database before the settings stage announces completion. Keep the
        // current document authoritative until that signal establishes absence
        // or presence of the remote document.
        if (this.sourcesState === "resolved") void this.resolveStorySources(true)
        break
      case "filter_list":
        this.actions.publishChanged("filters")
        void this.actions.refilterStories()
        break
      case "redirect_list":
        void this.actions.refreshRedirects()
        this.actions.publishChanged("redirects")
        break
      case FILTER_LISTS_DOCUMENT_ID:
      case USERSCRIPTS_DOCUMENT_ID:
        void this.actions.refreshExtensionSettings()
        this.actions.publishChanged("extensions")
        break
      case BROWSER_EXTENSION_SYNC_ID:
        this.actions.publishChanged("extensions")
        break
      case ADDONS_DOCUMENT_ID:
        this.actions.publishChanged("addons")
        break
      case "theme":
        void this.getTheme().then((theme) => this.theme.setTheme(theme))
        this.actions.publishChanged("theme")
        break
      case "animation":
        void this.getAnimation().then((animated) => {
          this.animated = animated
          this.actions.publishChanged("animation")
        })
        break
      case CACHE_TIMING_DOCUMENT_ID:
        // Timing decides how old a cached body may be, never what is on
        // screen, so nothing is reloaded and no request is made here.
        this.actions.publishChanged("cache")
        break
      case "swipe":
        this.actions.publishChanged("swipe")
        break
      case SAVE_BOOKMARKED_CONTENT_ID:
        this.actions.publishChanged("content")
        break
    }
  }

  private async resolveStorySources(reload: boolean, persistDefaults = true): Promise<void> {
    const stored = await this.getList<unknown>("sources", null)
    let document: StorySourceDocument
    if (stored !== null) {
      const parsed = parseStorySources(stored)
      if (!parsed.ok) {
        this.actions.reportDiagnostic({
          severity: "error",
          operation: "settings.load.sources",
          message: "The story source document is invalid; the previous sources remain active",
          details: parsed.reports.map((item) => `${item.path}: ${item.message}`).join("\n")
        })
        this.sourcesDocument ??= structuredClone(defaultStorySources)
        this.sourcesState = "resolved"
        return
      }
      document = parsed.doc
    } else if (persistDefaults) {
      document = structuredClone(defaultStorySources)
      await this.setList("sources", document)
    } else {
      return
    }
    const previous = this.sourcesDocument
    this.sourcesDocument = document
    this.sourcesState = "resolved"
    if (!previous || JSON.stringify(previous) !== JSON.stringify(document)) {
      if (previous) await this.actions.evictRemovedSources(previous, document)
      this.actions.updateSourceMenu(document)
      this.actions.publishChanged("sources")
      if (reload) await this.actions.reloadStories()
    }
  }

  private async setList<T>(id: string, value: T): Promise<void> {
    const serialized = JSON.stringify(value)
    this.pendingWrites.set(id, serialized)
    try {
      await this.listStore.set(id, value)
    } catch (error) {
      if (this.pendingWrites.get(id) === serialized) {
        this.pendingWrites.delete(id)
      }
      this.reportSaveError(
        `settings.save.${id}`,
        `Failed to save ${id.replaceAll("_", " ")}`,
        error
      )
      throw error
    }
  }

  private async getList<T>(id: string, fallback: T): Promise<T> {
    try {
      return await this.listStore.get(id, fallback)
    } catch (error) {
      this.reportLoadError(id, error)
      return fallback
    }
  }

  private reportLoadError(setting: string, error: unknown): void {
    this.actions.reportDiagnostic({
      severity: "error",
      operation: `settings.load.${setting}`,
      message: `The ${setting} setting could not be loaded; using defaults`,
      details: errorDetails(error)
    })
  }

  private reportSaveError(
    operation: string,
    message: string,
    error: unknown
  ): void {
    this.actions.reportDiagnostic({
      severity: "error",
      operation,
      message,
      details: errorDetails(error)
    })
  }
}

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return [error.name + ": " + error.message, error.stack]
    .filter(Boolean)
    .join("\n")
}
