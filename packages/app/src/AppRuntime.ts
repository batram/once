import {
  applyStoryFilter,
  applyStoryFilters,
  groupedStorySources,
  Story,
  StorySourceDocument,
  URLRedirect
} from "@once/core"
import {
  CachePolicy,
  DatabaseChange,
  DiagnosticError,
  OnceClient,
  OncePlatformPorts,
  ProcessingSource,
  SourceError,
  StoryChangeDetail,
  SyncStatus
} from "./types"
import { LocalEventBus } from "./EventBus"
import { mergeStorySyncState, sameStorySyncState } from "./storySyncPolicy"
import { StoryWriteQueue } from "./StoryWriteQueue"
import { StoryWorkingSet } from "./StoryWorkingSet"
import { AppSettings } from "./AppSettings"
import { CacheMaintenance } from "./cacheMaintenance"
import {
  DEFAULT_MENU_TYPES,
  SourceMenu,
  sourceMenuFromDocument
} from "./sourceMenu"
import { SourceLoader } from "./SourceLoader"
import { DiagnosticLog, errorDetails } from "./DiagnosticLog"
import { fetchDocument } from "./fetchDocument"
import { waitForStartupStorage } from "./startupStorage"

export class AppRuntime {
  readonly client: OnceClient
  private readonly events = new LocalEventBus()
  private readonly workingSet = new StoryWorkingSet(
    (href, story, previous) =>
      this.emitDataChange([href], story, previous, null),
    (story) =>
      this.events.publish("storiesChanged", {
        stories: [story],
        bucket: typeof story.bucket === "string" ? story.bucket : "stories"
      }),
    (href) => this.events.publish("storyRemoved", { href })
  )
  private readonly sourceErrors = new Map<string, SourceError>()
  private readonly diagnostics = new DiagnosticLog(
    (error) => this.events.publish("diagnosticError", error)
  )
  private menu: SourceMenu = { groups: [], types: DEFAULT_MENU_TYPES }
  private readonly storyWrites = new StoryWriteQueue(
    (href, failure, error) => {
      console.error(`${failure.message}: ${href}`, error)
      this.reportDiagnostic({
        severity: "error",
        operation: failure.operation,
        message: failure.message,
        storyUrl: href,
        details: errorDetails(error)
      })
    }
  )
  private readonly settings: AppSettings
  private readonly cacheMaintenance: CacheMaintenance
  private readonly sourceLoader: SourceLoader
  private syncStatus: SyncStatus = {
    state: "disabled",
    message: "Sync is not configured"
  }
  private sourceSettingsReady: Promise<void> = Promise.resolve()

  constructor(private platform: OncePlatformPorts) {
    this.settings = new AppSettings(
      platform.listStore,
      platform.syncSettingsStore,
      platform.syncService,
      platform.theme,
      {
        publishChanged: (section) =>
          this.events.publish("settingsChanged", { section }),
        reportDiagnostic: (error) => this.reportDiagnostic(error),
        reloadStories: () => this.reloadStories("cache-first"),
        refilterStories: () => this.refilterStories(),
        refreshRedirects: () => this.refreshRedirects(),
        updateSourceMenu: (sources) => this.updateSourceMenu(sources),
        evictRemovedSources: (previous, current) =>
          this.cacheMaintenance.evictRemoved(previous, current),
        loadedStoryIds: () =>
          this.workingSet.hrefs().map((href) =>
            this.platform.storyStore.storyId(href)
          )
      }
    )
    this.cacheMaintenance = new CacheMaintenance(
      this.settings,
      platform.cacheStore,
      () => this.events.publish("cacheStatusChanged", {})
    )
    this.sourceLoader = new SourceLoader(
      platform.fetch,
      platform.cacheStore,
      (error) => this.setSourceError(error)
    )
    this.client = this.createClient()
  }

  async start(): Promise<void> {
    this.platform.storyStore.onDiagnostic?.((error) => this.reportDiagnostic(error))
    this.platform.syncService?.onDiagnostic?.((error) =>
      this.reportDiagnostic(error)
    )
    this.platform.syncService?.onStatus?.((status) => {
      this.syncStatus = status
      this.events.publish("syncStatusChanged", status)
    })
    this.platform.syncService?.onRemoteChange?.((change) => {
      const href =
        typeof change.doc?.href === "string"
          ? change.doc.href
          : change.id.replace(/^sto_/, "")
      void this.queueStoryWrite(
        href,
        () => this.handleRemoteDatabaseChange(change),
        {
          operation: "story.sync",
          message: "A synchronized story change could not be applied"
        }
      ).catch(() => undefined)
    })
    this.platform.onDatabaseChange?.((change) => {
      if (!change.id.startsWith("sto_")) {
        this.settings.handleObservedChange(change)
        return
      }
      const href =
        typeof change.doc?.href === "string"
          ? change.doc.href
          : change.id.replace(/^sto_/, "")
      void this.queueStoryWrite(
        href,
        () => this.handleObservedStoryChange(change),
        {
          operation: "story.observe",
          message: "A local database story change could not be reconciled"
        }
      ).catch(() => undefined)
    })

    await Promise.all([
      this.waitForStartupStorage("stared stories", async () => {
        const staredStories = await this.platform.storyStore.getStaredStories()
        staredStories.forEach((story) => this.workingSet.add(story))
      }),
      this.waitForStartupStorage("animation", async () => {
        this.settings.animated = await this.settings.getAnimation()
      }),
      this.waitForStartupStorage("theme", async () => {
        this.platform.theme.setTheme(await this.settings.getTheme())
      }),
      this.waitForStartupStorage("redirects", () => this.refreshRedirects())
    ])

    this.sourceSettingsReady = this.settings.getSyncUrl()
      .then((syncUrl) => this.settings.startSync(syncUrl))
    await this.waitForStartupStorage("sync", () => this.sourceSettingsReady)

    this.platform.activeTab?.onSelectedUrlChanged((url) => {
      this.client.selectUrl(url)
    })
    this.platform.onHistoryCommand?.((action) => {
      this.events.publish("historyCommand", { action })
    })
    this.emitMenuChanged()
  }

  private createClient(): OnceClient {
    return {
      getDiagnostics: () => this.diagnostics.snapshot(),
      getSyncStatus: () => this.syncStatus,
      getStorySources: () => this.sourceSettingsReady
        .then(() => this.settings.getStorySources()),
      saveStorySources: (storySources, reloadStories) =>
        this.settings.saveStorySources(storySources, reloadStories),
      getFilterList: () => this.settings.getFilterList(),
      saveFilterList: (filterList) => this.settings.saveFilterList(filterList),
      getRedirectList: () => this.settings.getRedirectList(),
      saveRedirectList: (redirectList) =>
        this.settings.saveRedirectList(redirectList),
      getSyncUrl: () => this.settings.getSyncUrl(),
      setSyncUrl: (syncUrl) => this.settings.setSyncUrl(syncUrl),
      getCacheTime: () => this.settings.getCacheTime(),
      setCacheTime: (cacheTime) => this.settings.setCacheTime(cacheTime),
      getCacheTiming: () => this.settings.getCacheTiming(),
      setCacheTiming: (timing) => this.settings.setCacheTiming(timing),
      getTheme: () => this.settings.getTheme(),
      setTheme: (theme) => this.settings.setTheme(theme),
      getAnimation: () => this.settings.getAnimation(),
      setAnimation: (animated) => this.settings.setAnimation(animated),
      getSwipeSettings: () => this.settings.getSwipeSettings(),
      setSwipeSettings: (settings) => this.settings.setSwipeSettings(settings),
      reloadStories: (policy = "cache-first") => this.reloadStories(policy),
      refetchSource: (sourceId) => this.reloadStories("network-only", sourceId),
      getSourceCacheStatus: () => this.cacheMaintenance.status(),
      clearCachedFeeds: () => this.cacheMaintenance.clear(),
      getStories: () => this.getWorkingStories(),
      getStorySnapshot: () => this.workingSet.snapshot(),
      findStoryByUrl: async (url) => this.findStoryByUrl(url),
      settledStoryWrites: () => this.settledStoryWrites(),
      persistStoryChange: (href, path, value) =>
        this.persistStoryChange(href, path, value),
      purgeStory: (href) => this.purgeStory(href),
      addFilter: (filter) => this.settings.addFilter(filter),
      fetchDocument: (url) => fetchDocument(this.platform.fetch, url),
      openUrl: (url, target) => {
        if (url.startsWith("search:")) {
          this.events.publish("searchRequested", {
            query: url.substring("search:".length)
          })
        } else {
          this.platform.activeTab?.openUrl(url, target)
        }
      },
      selectUrl: async (url) => {
        this.events.publish("selectedUrlChanged", { url })
      },
      subscribe: (event, handler) => this.events.subscribe(event, handler)
    }
  }

  private async refreshRedirects(): Promise<void> {
    const redirects = await this.settings.getRedirectList()
    URLRedirect.setRedirects(redirects)
    //setRedirects drops the rewritten -> original lookup, rebuild it
    for (const story of this.workingSet.values()) {
      URLRedirect.redirect_url(story.href)
    }
    this.events.publish("redirectsChanged", { redirects })
  }

  private async refilterStories(): Promise<void> {
    const filterList = await this.settings.getFilterList()
    for (const story of this.workingSet.values()) {
      const previousFilter = story.filter
      applyStoryFilter(filterList, story)
      if (story.filter !== previousFilter) {
        await this.persistStoryChange(story.href, "filter", story.filter)
      }
    }
  }

  /**
   * One reload pass. `only` narrows it to a single source, which is what a
   * per-source refetch is: the same pass, forced, for one row. Its errors are
   * cleared alone so a refetch cannot wipe another source's reported failure.
   */
  private async reloadStories(
    policy: CachePolicy = "cache-first",
    only?: string
  ): Promise<void> {
    if (only) this.sourceErrors.delete(only); else this.sourceErrors.clear()
    this.emitSourceErrors()
    const storySources = await this.settings.getStorySources()
    // Resolved once, before the fan-out below, so a settings write cannot make
    // one half of a reload disagree with the other about how stale is stale.
    const cacheWindow = await this.settings.cacheWindows()
    const groupedSources = groupedStorySources(storySources)
    this.updateSourceMenu(storySources)
    const processingSources = new Map<string, ProcessingSource>()
    const promises: Promise<void>[] = []

    for (const group of groupedSources) {
      const loadable = group.sources.filter((item) => item.enabled !== false &&
        (!only || item.id === only))
      for (const source of loadable) {
        const sourceInfo = this.sourceLoader.describe(source)
        processingSources.set(source.id, sourceInfo)
        this.emitLoader(processingSources)
        promises.push(
          this.sourceLoader.load(source, { policy, cacheMinutes: cacheWindow(source) })
            .then(async (stories) => {
              await this.processStoryInput(stories, group.name)
            })
            .catch((error) => {
              this.sourceLoader.reportLoadFailure(source, error)
            })
            .finally(() => {
              processingSources.delete(source.id)
              this.emitLoader(processingSources)
            })
        )
      }
    }

    await Promise.all(promises)
    if (promises.length) this.events.publish("cacheStatusChanged", {})
    this.events.publish("loaderChanged", {
      processing: [],
      visible: false
    })
  }

  private async processStoryInput(
    stories: Story[] | undefined,
    groupName: string
  ): Promise<void> {
    if (!stories) return

    const filterList = await this.settings.getFilterList()
    const filteredStories = applyStoryFilters(filterList, stories).sort()
    filteredStories.forEach((story) => {
      story.tags.push({
        class: "group",
        text: "*" + groupName,
        href: "search:" + "*" + groupName
      })
    })

    const mappedStories = await this.addStories(filteredStories)
    this.getAllStared().forEach((story) => mappedStories.push(story))
    this.events.publish("storiesChanged", {
      stories: mappedStories,
      bucket: "stories"
    })
  }

  private setSourceError(error: SourceError): void {
    this.sourceErrors.set(error.sourceId, error)
    this.emitSourceErrors()
  }

  private emitSourceErrors(): void {
    this.events.publish("sourceErrorsChanged", {
      errors: Array.from(this.sourceErrors.values())
    })
  }

  private emitLoader(processingSources: Map<string, ProcessingSource>): void {
    this.events.publish("loaderChanged", {
      processing: Array.from(processingSources.values()),
      visible: processingSources.size > 0
    })
  }

  private emitMenuChanged(): void {
    this.events.publish("menuChanged", { ...this.menu })
  }

  private updateSourceMenu(storySources: StorySourceDocument): void {
    const menu = sourceMenuFromDocument(storySources, (source) =>
      this.sourceLoader.describe(source).parserType)
    this.menu = menu
    this.emitMenuChanged()
  }

  private async addStories(stories: Story[]): Promise<Story[]> {
    const stored = await this.platform.storyStore.getStoriesByUrls(
      stories.map((story) => story.href)
    )
    return Promise.all(
      stories.map((story) => this.addStory(story, "stories", stored.get(story.href)))
    )
  }

  private getAllStared(): Story[] {
    return this.workingSet.snapshot().filter((story) => story.stared)
  }

  private addStory(
    newStory: Story,
    bucket = "stories",
    storedStory?: Story
  ): Promise<Story> {
    return this.queueStoryWrite(newStory.href, () =>
      this.addStoryNow(newStory, bucket, storedStory)
    )
  }

  // Serialize writes per story URL so saves reach storage in interaction
  // order; writes for different stories stay concurrent.
  private queueStoryWrite<T>(
    href: string,
    task: () => Promise<T>,
    failure: Pick<DiagnosticError, "operation" | "message"> = {
      operation: "story.save",
      message: "A story change could not be saved"
    }
  ): Promise<T> {
    return this.storyWrites.enqueue(href, task, failure)
  }

  // Resolves once every story write queued so far has settled; save failures
  // are already logged by queueStoryWrite, so they do not reject here.
  private async settledStoryWrites(): Promise<void> {
    await this.storyWrites.settled()
  }

  private async addStoryNow(
    newStory: Story,
    bucket = "stories",
    storedStory?: Story
  ): Promise<Story> {
    if (!(newStory instanceof Story)) {
      throw new Error("Please, only add Story instances")
    }
    Story.assertIngestible(newStory)

    newStory.bucket = bucket
    const workingStory = this.workingSet.get(newStory.href)
    let oldStory: Story | null | undefined = workingStory ?? storedStory

    if (!oldStory) {
      newStory = this.workingSet.set(newStory.href.toString(), newStory)
      return this.platform.storyStore.saveStory(newStory)
    }

    // A story returned to a caller for presentation must also be present in
    // the authoritative working set. Previously a stored story could be
    // returned to StoryList without being registered here. A later sync then
    // looked like a new insertion, which StoryList deduplicated against its
    // stale row instead of updating it.
    if (!workingStory) {
      oldStory = this.workingSet.set(oldStory.href, oldStory, true)
    }

    if (
      newStory.comment_url == oldStory.comment_url &&
      JSON.stringify(newStory.tags) != JSON.stringify(oldStory.tags)
    ) {
      const previousTags = [...oldStory.tags]
      const existingStory = oldStory
      newStory.tags.forEach((tag) => {
        if (!existingStory.tags.map((existingTag) => existingTag.text).includes(tag.text)) {
          existingStory.tags.push(tag)
        }
      })
      this.emitDataChange([oldStory.href, "tags"], oldStory.tags, previousTags, null)
      oldStory = await this.platform.storyStore.saveStory(oldStory)
    }

    const oldCommentUrls = oldStory.substories.map((substory) => {
      return substory.comment_url
    })

    if (
      newStory.comment_url &&
      newStory.comment_url != oldStory.comment_url &&
      !oldCommentUrls.includes(newStory.comment_url)
    ) {
      const previousSubstories = [...oldStory.substories]
      oldStory.substories.push({
        type: newStory.type,
        comment_url: newStory.comment_url,
        timestamp: newStory.timestamp,
        tags: newStory.tags
      })
      this.emitDataChange(
        [oldStory.href, "substories"],
        oldStory.substories,
        previousSubstories,
        null
      )
      oldStory = await this.platform.storyStore.saveStory(oldStory)
    }

    return oldStory
  }

  private async getWorkingStories(): Promise<Story[]> {
    const [stored, stared] = await Promise.all([
      this.platform.storyStore.getStories(500),
      this.platform.storyStore.getStaredStories()
    ])
    stored
      .concat(stared)
      .forEach((story) => this.workingSet.set(story.href, story, true))
    return this.workingSet.snapshot()
  }

  private async findStoryByUrl(url: string): Promise<Story | null> {
    const story = this.workingSet.lookup(url)
    if (story) {
      return story
    }
    //the url might be the rewritten form of a story href
    const original = URLRedirect.original_url(url)
    if (original !== url) {
      const rewritten = this.workingSet.lookup(original)
      if (rewritten) return rewritten
    }
    const stored = await this.platform.storyStore.getStory(original)
    if (stored) return this.workingSet.set(stored.href, stored, true)
    await this.getWorkingStories()
    return this.workingSet.lookup(url) ??
      this.workingSet.lookup(URLRedirect.original_url(url))
  }

  private async persistStoryChange(
    href: string,
    path: string,
    value: Story | string | boolean
  ): Promise<Story | undefined> {
    let story = this.workingSet.get(href)
    if (!story) {
      const stored = await this.platform.storyStore.getStory(href)
      if (stored) story = this.workingSet.set(stored.href, stored, true)
    }
    if (!story) return undefined

    const previousValue = story[path]
    story[path] = value
    const previousUpdate = story.sync_updated_at?.[path] ?? 0
    story.sync_updated_at = {
      ...story.sync_updated_at,
      [path]: Math.max(Date.now(), previousUpdate + 1)
    }
    this.emitDataChange([href, path], value, previousValue, null)

    // Save a snapshot so each queued write persists exactly this transition
    // even if the live story mutates again before the save runs.
    const snapshot = Story.from_obj(story.to_obj())
    return this.queueStoryWrite(href, async () => {
      const saved = await this.platform.storyStore.saveStory(snapshot)
      const current = this.workingSet.get(href)
      if (current === story) {
        story._id = saved._id
        story._rev = saved._rev
      } else if (current) {
        const reconciled = mergeStorySyncState(current, saved)
        reconciled._id = saved._id
        reconciled._rev = saved._rev
        this.workingSet.set(href, reconciled)
      } else {
        this.workingSet.set(href, saved)
      }
      return this.workingSet.get(href) ?? saved
    })
  }

  private async purgeStory(href: string): Promise<void> {
    await this.settledStoryWrites()
    try {
      await this.platform.storyStore.deleteStory(href)
    } catch (error) {
      this.reportDiagnostic({
        severity: "error",
        operation: "story.delete",
        message: "The story could not be purged",
        storyUrl: href,
        details: errorDetails(error)
      })
      throw error
    }
    this.workingSet.remove(href)
  }

  private emitDataChange(
    path: string[],
    value: unknown,
    previousValue: unknown,
    name: string | null
  ): void {
    const story = path.length > 0 ? this.workingSet.get(path[0]) : undefined
    if (!story) return

    const detail: StoryChangeDetail = {
      story,
      path,
      value,
      previousValue,
      name,
      animated: this.settings.animated
    }
    this.events.publish("storyChanged", detail)
  }

  private reportDiagnostic(error: DiagnosticError): void {
    this.diagnostics.report(error)
  }

  private reportStartupSettingError(setting: string, error: unknown): void {
    this.diagnostics.reportSettingLoad(setting, error)
  }

  private async waitForStartupStorage(
    label: string,
    operation: () => Promise<void>
  ): Promise<void> {
    return waitForStartupStorage(label, operation, {
      timedOut: (timedOutLabel) => this.reportDiagnostic({
        severity: "warning",
        operation: `startup.${timedOutLabel.replaceAll(" ", "-")}`,
        message: `Still loading ${timedOutLabel}; startup is continuing`,
        details:
          "The local database did not respond during the startup window. " +
          "The operation is continuing in the background."
      }),
      failed: (failedLabel, error) =>
        this.reportStartupSettingError(failedLabel, error)
    })
  }

  private async handleObservedStoryChange(
    change: DatabaseChange
  ): Promise<void> {
    if (change.doc?._deleted) {
      this.workingSet.remove(change.id.substring("sto_".length))
      return
    }
    if (!change.doc) return

    const changedStory = Story.from_obj(change.doc)
    const currentStory = this.workingSet.get(changedStory.href)
    if (!currentStory) return

    const storedStory = await this.platform.storyStore.getStory(
      changedStory.href
    )
    if (!storedStory) {
      this.workingSet.remove(changedStory.href)
      return
    }

    const reconciled = mergeStorySyncState(storedStory, currentStory)
    let effectiveStory = storedStory
    if (!sameStorySyncState(reconciled, storedStory)) {
      effectiveStory = await this.platform.storyStore.saveStory(reconciled)
    }
    if (
      currentStory._rev !== effectiveStory._rev ||
      !sameStorySyncState(currentStory, effectiveStory)
    ) {
      this.workingSet.set(effectiveStory.href, effectiveStory)
    }
  }

  private async handleRemoteDatabaseChange(
    change: DatabaseChange
  ): Promise<void> {
    if (!change.id.startsWith("sto_") || !change.doc) return

    if (change.doc._deleted) {
      this.workingSet.remove(change.id.substring("sto_".length))
      return
    }

    const remoteStory = Story.from_obj(change.doc)
    const currentStory = this.workingSet.get(remoteStory.href)
    const localStory = await this.platform.storyStore.getStory(remoteStory.href)
    const mergeBase = localStory ?? currentStory ?? remoteStory
    // Timestamped offline edits win by time. Untimestamped feed defaults use
    // the legacy rank and therefore cannot replace an established read,
    // skipped, starred, or filtered state.
    const merged = mergeStorySyncState(mergeBase, remoteStory)
    let effectiveStory = localStory ?? remoteStory

    if (!sameStorySyncState(merged, effectiveStory)) {
      effectiveStory = await this.platform.storyStore.saveStory(merged)
    }

    if (currentStory) {
      if (
        currentStory._rev !== effectiveStory._rev ||
        !sameStorySyncState(currentStory, effectiveStory)
      ) {
        this.workingSet.set(effectiveStory.href, effectiveStory)
      }
      return
    }

    if (change.presentation !== "background") {
      this.workingSet.add(effectiveStory)
    }
  }
}
