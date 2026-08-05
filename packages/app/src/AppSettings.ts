import {
  defaultFilterList,
  defaultRedirectList,
  defaultSources,
  convertLegacySourceLines,
  legacySourceDigest,
  normalizeSyncUrl,
  parseStorySources,
  StorySourceDocument,
  Redirect
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

export interface AppSettingsActions {
  publishChanged(section: SettingsSection): void
  reportDiagnostic(error: DiagnosticError): void
  reloadStories(): Promise<void> | void
  refilterStories(): Promise<void> | void
  refreshRedirects(): Promise<void> | void
  updateSourceMenu(sources: StorySourceDocument): void
  loadedStoryIds(): string[]
}

export class AppSettings {
  private readonly pendingWrites = new Map<string, string>()
  private sourcesState: "pending" | "resolved" = "pending"
  private sourcesDocument?: StorySourceDocument
  private legacyDigest?: string
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
    if (this.sourcesState === "resolved" && this.sourcesDocument) {
      return structuredClone(this.sourcesDocument)
    }
    const legacy = await this.getList("story_sources", defaultSources)
    return convertLegacySourceLines(legacy).doc
  }

  async saveStorySources(sources: StorySourceDocument, reload = true): Promise<void> {
    const parsed = parseStorySources(sources)
    if (!parsed.ok) {
      throw new Error(parsed.reports.map((item) => `${item.path}: ${item.message}`).join("\n"))
    }
    await this.setList("sources", parsed.doc)
    this.sourcesDocument = parsed.doc
    this.sourcesState = "resolved"
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
    if (normalizedUrl !== await this.getSyncUrl()) {
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
      this.startSync(normalizedUrl)
    }
    this.actions.publishChanged("sync")
  }

  startSync(syncUrl: string): void {
    if (!syncUrl.trim()) void this.resolveStorySources(false)
    this.syncService?.syncFrom(syncUrl, () => this.actions.loadedStoryIds())
  }

  async getCacheTime(): Promise<number> {
    try {
      return await this.syncStore.getCacheTime()
    } catch (error) {
      this.reportLoadError("cache", error)
      return 120
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
        void this.resolveStorySources(true)
        break
      case "story_sources":
        if (this.sourcesState === "resolved") void this.reportLegacyDivergence()
        break
      case "filter_list":
        this.actions.publishChanged("filters")
        void this.actions.refilterStories()
        break
      case "redirect_list":
        void this.actions.refreshRedirects()
        this.actions.publishChanged("redirects")
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
      case "swipe":
        this.actions.publishChanged("swipe")
        break
    }
  }

  private async resolveStorySources(reload: boolean): Promise<void> {
    const legacy = await this.getList("story_sources", defaultSources)
    const stored = await this.getList<unknown>("sources", null)
    let document: StorySourceDocument
    if (stored !== null) {
      const parsed = parseStorySources(stored)
      if (!parsed.ok) {
        this.actions.reportDiagnostic({
          severity: "error",
          operation: "settings.load.sources",
          message: "The story source document is invalid; legacy sources remain active",
          details: parsed.reports.map((item) => `${item.path}: ${item.message}`).join("\n")
        })
        return
      }
      document = parsed.doc
    } else {
      document = convertLegacySourceLines(legacy).doc
      await this.setList("sources", document)
    }
    const previous = this.sourcesDocument
    this.sourcesDocument = document
    this.sourcesState = "resolved"
    this.legacyDigest = legacySourceDigest(legacy)
    if (document.migratedFrom && document.migratedFrom.digest !== this.legacyDigest) {
      this.reportSplitBrain(document.migratedFrom.digest, this.legacyDigest)
    }
    if (!previous || JSON.stringify(previous) !== JSON.stringify(document)) {
      this.actions.updateSourceMenu(document)
      this.actions.publishChanged("sources")
      if (reload) await this.actions.reloadStories()
    }
  }

  private async reportLegacyDivergence(): Promise<void> {
    const legacy = await this.getList("story_sources", defaultSources)
    const digest = legacySourceDigest(legacy)
    if (digest !== this.legacyDigest) this.reportSplitBrain(this.legacyDigest, digest)
  }

  private reportSplitBrain(expected: string | undefined, actual: string): void {
    this.actions.reportDiagnostic({
      severity: "warning",
      operation: "settings.sources.legacy-diverged",
      message: "Legacy story sources changed after the typed-source cutover",
      details: `Expected legacy digest ${expected ?? "unknown"}; observed ${actual}. The sources document remains authoritative.`,
      documentId: "story_sources"
    })
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
