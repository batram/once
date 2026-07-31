import {
  applyStoryFilter,
  applyStoryFilters,
  groupStorySources,
  Story,
  URLRedirect
} from "@once/core"
import {
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
  private readonly menuGroups = new Set<string>()
  private readonly menuTypes = new Set<string>([
    "ALL",
    "filtered",
    "stared",
    "new"
  ])
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
  private readonly sourceLoader: SourceLoader
  private syncStatus: SyncStatus = {
    state: "disabled",
    message: "Sync is not configured"
  }

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
        reloadStories: () => this.reloadStories(true),
        refilterStories: () => this.refilterStories(),
        refreshRedirects: () => this.refreshRedirects(),
        updateSourceMenu: (sources) => this.updateSourceMenu(sources),
        loadedStoryIds: () =>
          this.workingSet.hrefs().map((href) =>
            this.platform.storyStore.storyId(href)
          )
      }
    )
    this.sourceLoader = new SourceLoader(
      platform.fetch,
      platform.cacheStore,
      () => this.settings.getCacheTime(),
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

    await this.waitForStartupStorage("sync", async () => {
      const syncUrl = await this.settings.getSyncUrl()
      this.settings.startSync(syncUrl)
    })

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
      getStorySources: () => this.settings.getStorySources(),
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
      getTheme: () => this.settings.getTheme(),
      setTheme: (theme) => this.settings.setTheme(theme),
      getAnimation: () => this.settings.getAnimation(),
      setAnimation: (animated) => this.settings.setAnimation(animated),
      getSwipeSettings: () => this.settings.getSwipeSettings(),
      setSwipeSettings: (settings) => this.settings.setSwipeSettings(settings),
      reloadStories: (tryCache = true) => this.reloadStories(tryCache),
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

  private async reloadStories(tryCache = true): Promise<void> {
    this.sourceErrors.clear()
    this.emitSourceErrors()
    const storySources = await this.settings.getStorySources()
    const groupedSources = groupStorySources(storySources)
    this.updateSourceMenu(storySources)
    const processingSources = new Map<string, ProcessingSource>()
    const promises: Promise<void>[] = []

    for (const groupName in groupedSources) {
      for (const sourceUrl of groupedSources[groupName]) {
        const sourceInfo = this.sourceLoader.describe(sourceUrl)
        processingSources.set(sourceUrl, sourceInfo)
        this.emitLoader(processingSources)
        promises.push(
          this.sourceLoader.load(sourceUrl, tryCache)
            .then(async (stories) => {
              await this.processStoryInput(stories, groupName)
            })
            .catch((error) => {
              this.sourceLoader.reportLoadFailure(sourceUrl, error)
            })
            .finally(() => {
              processingSources.delete(sourceUrl)
              this.emitLoader(processingSources)
            })
        )
      }
    }

    await Promise.all(promises)
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
    this.sourceErrors.set(error.url, error)
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
    this.events.publish("menuChanged", {
      groups: Array.from(this.menuGroups),
      types: Array.from(this.menuTypes)
    })
  }

  private updateSourceMenu(storySources: string[]): void {
    const groupedSources = groupStorySources(storySources)
    this.menuGroups.clear()
    this.menuTypes.clear()
    for (const type of ["ALL", "filtered", "stared", "new"]) {
      this.menuTypes.add(type)
    }
    for (const groupName of Object.keys(groupedSources)) {
      this.menuGroups.add(groupName)
      for (const sourceUrl of groupedSources[groupName]) {
        const sourceInfo = this.sourceLoader.describe(sourceUrl)
        if (sourceInfo.parserType !== "Unknown") {
          this.menuTypes.add(sourceInfo.parserType)
        }
      }
    }
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
