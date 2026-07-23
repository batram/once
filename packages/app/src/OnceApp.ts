import {
  applyStoryFilter,
  applyStoryFilters,
  defaultFilterList,
  defaultRedirectList,
  defaultSources,
  groupStorySources,
  Redirect,
  Story,
  URLRedirect
} from "@once/core"
import * as StoryParser from "@once/collectors"
import {
  AnimationSetting,
  DatabaseChange,
  DiagnosticError,
  OnceClient,
  OnceEventHandler,
  OnceEventName,
  OncePlatformPorts,
  ProcessingSource,
  SourceError,
  StoryChangeDetail,
  SyncStatus,
  ThemeName
} from "./types"
import { LocalEventBus } from "./EventBus"

export class OnceApp {
  readonly client: OnceClient
  private readonly events = new LocalEventBus()
  private readonly stories = new Map<string, Story>()
  private readonly comments = new Map<string, string>()
  private readonly sourceErrors = new Map<string, SourceError>()
  private readonly diagnostics: DiagnosticError[] = []
  private readonly diagnosticKeys = new Set<string>()
  private readonly menuGroups = new Set<string>()
  private readonly menuTypes = new Set<string>([
    "ALL",
    "filtered",
    "stared",
    "new"
  ])
  // Suppress local PouchDB echoes already applied by save methods.
  private readonly pendingSettingWrites = new Map<string, string>()
  private readonly storyWrites = new Map<string, Promise<unknown>>()
  private animated = true
  private syncStatus: SyncStatus = {
    state: "disabled",
    message: "Sync is not configured"
  }

  constructor(private platform: OncePlatformPorts) {
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
        this.handleDatabaseChange(change)
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

    try {
      this.animated = await this.getAnimation()
    } catch (error) {
      this.reportStartupSettingError("animation", error)
    }
    try {
      this.platform.theme.setTheme(await this.getTheme())
    } catch (error) {
      this.reportStartupSettingError("theme", error)
    }
    try {
      await this.refreshRedirects()
    } catch (error) {
      this.reportStartupSettingError("redirects", error)
    }
    try {
      const syncUrl = await this.getSyncUrl()
      this.platform.syncService?.syncFrom(syncUrl)
    } catch (error) {
      this.reportStartupSettingError("sync", error)
    }

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
      getDiagnostics: () => [...this.diagnostics],
      getSyncStatus: () => this.syncStatus,
      getStorySources: () => this.getStorySources(),
      saveStorySources: (storySources) => this.saveStorySources(storySources),
      getFilterList: () => this.getFilterList(),
      saveFilterList: (filterList) => this.saveFilterList(filterList),
      getRedirectList: () => this.getRedirectList(),
      saveRedirectList: (redirectList) => this.saveRedirectList(redirectList),
      getSyncUrl: () => this.getSyncUrl(),
      setSyncUrl: (syncUrl) => this.setSyncUrl(syncUrl),
      getCacheTime: () => this.getCacheTime(),
      setCacheTime: (cacheTime) => this.setCacheTime(cacheTime),
      getTheme: () => this.getTheme(),
      setTheme: (theme) => this.setTheme(theme),
      getAnimation: () => this.getAnimation(),
      setAnimation: (animated) => this.setAnimation(animated),
      reloadStories: (tryCache = true) => this.reloadStories(tryCache),
      getStories: () => this.getWorkingStories(),
      getStorySnapshot: () => Array.from(this.stories.values()),
      findStoryByUrl: async (url) => this.findStoryByUrl(url),
      settledStoryWrites: () => this.settledStoryWrites(),
      persistStoryChange: (href, path, value) =>
        this.persistStoryChange(href, path, value),
      purgeStory: (href) => this.purgeStory(href),
      addFilter: (filter) => this.addFilter(filter),
      fetchDocument: (url) => this.fetchDocument(url),
      openUrl: (url, target) => this.openUrl(url, target),
      selectUrl: (url) => this.selectUrl(url),
      subscribe: (event, handler) => this.subscribe(event, handler)
    }
  }

  private async fetchDocument(url: string): Promise<{ html: string; url: string }> {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("Reader mode only supports HTTP and HTTPS pages")
    }
    const response = await this.platform.fetch(parsed.toString(), {
      credentials: "omit"
    })
    if (!response.ok) {
      if (response.status === 429) {
        throw new Error(
          "The site rate-limited the reader request (HTTP 429). Try again later or open the original page."
        )
      }
      const detail = response.statusText ? `: ${response.statusText}` : ""
      throw new Error(`The reader request failed with HTTP ${response.status}${detail}`)
    }
    const contentType = response.headers.get("content-type") || ""
    if (!contentType.toLowerCase().includes("text/html")) {
      throw new Error(`Reader mode cannot display ${contentType || "this content type"}`)
    }
    return { html: await response.text(), url: response.url || parsed.toString() }
  }

  private subscribe<T extends OnceEventName>(
    event: T,
    handler: OnceEventHandler<T>
  ): () => void {
    return this.events.subscribe(event, handler)
  }

  private async getStorySources(): Promise<string[]> {
    return this.getListSetting("story_sources", defaultSources)
  }

  private async saveStorySources(storySources: string[]): Promise<void> {
    await this.setListSetting("story_sources", storySources)
    this.events.publish("settingsChanged", { section: "sources" })
    await this.reloadStories(true)
  }

  private async getFilterList(): Promise<string[]> {
    return this.getListSetting("filter_list", defaultFilterList)
  }

  private async saveFilterList(filterList: string[]): Promise<void> {
    await this.setListSetting("filter_list", filterList)
    this.events.publish("settingsChanged", { section: "filters" })
    await this.refilterStories()
  }

  private async getRedirectList(): Promise<Redirect[]> {
    return this.getListSetting("redirect_list", defaultRedirectList)
  }

  private async saveRedirectList(redirectList: Redirect[]): Promise<void> {
    await this.setListSetting("redirect_list", redirectList)
    await this.refreshRedirects()
    this.events.publish("settingsChanged", { section: "redirects" })
  }

  private async setListSetting<T>(id: string, value: T): Promise<void> {
    const serialized = JSON.stringify(value)
    this.pendingSettingWrites.set(id, serialized)
    try {
      await this.platform.listStore.set(id, value)
    } catch (error) {
      if (this.pendingSettingWrites.get(id) === serialized) {
        this.pendingSettingWrites.delete(id)
      }
      this.reportDiagnostic({
        severity: "error",
        operation: `settings.save.${id}`,
        message: `Failed to save ${id.replaceAll("_", " ")}`,
        details: errorDetails(error)
      })
      throw error
    }
  }

  private async getListSetting<T>(id: string, fallback: T): Promise<T> {
    try {
      return await this.platform.listStore.get(id, fallback)
    } catch (error) {
      this.reportStartupSettingError(id, error)
      return fallback
    }
  }

  private async getSyncUrl(): Promise<string> {
    try {
      return await this.platform.syncSettingsStore.getSyncUrl()
    } catch (error) {
      this.reportStartupSettingError("sync", error)
      return ""
    }
  }

  private async setSyncUrl(syncUrl: string): Promise<void> {
    const oldUrl = await this.getSyncUrl()
    if (syncUrl !== oldUrl) {
      try {
        await this.platform.syncSettingsStore.setSyncUrl(syncUrl)
      } catch (error) {
        this.reportDiagnostic({
          severity: "error",
          operation: "settings.save.sync",
          message: "The sync setting could not be saved",
          details: errorDetails(error)
        })
        throw error
      }
      this.platform.syncService?.syncFrom(syncUrl)
    }
    this.events.publish("settingsChanged", { section: "sync" })
  }

  private async getCacheTime(): Promise<number> {
    try {
      return await this.platform.syncSettingsStore.getCacheTime()
    } catch (error) {
      this.reportStartupSettingError("cache", error)
      return 120
    }
  }

  private async setCacheTime(cacheTime: string): Promise<void> {
    const parsedCacheTime = parseInt(cacheTime)
    if (parsedCacheTime === await this.getCacheTime()) {
      this.events.publish("settingsChanged", { section: "cache" })
      return
    }
    try {
      await this.platform.syncSettingsStore.setCacheTime(cacheTime)
    } catch (error) {
      this.reportDiagnostic({
        severity: "error",
        operation: "settings.save.cache",
        message: "The cache setting could not be saved",
        details: errorDetails(error)
      })
      throw error
    }
    this.events.publish("settingsChanged", { section: "cache" })
  }

  private getTheme(): Promise<ThemeName> {
    return this.getListSetting("theme", "dark" as ThemeName)
  }

  private async setTheme(theme: ThemeName): Promise<void> {
    if (theme === await this.getTheme()) {
      this.platform.theme.setTheme(theme)
      this.events.publish("settingsChanged", { section: "theme" })
      return
    }
    await this.setListSetting("theme", theme)
    this.platform.theme.setTheme(theme)
    this.events.publish("settingsChanged", { section: "theme" })
  }

  private getAnimation(): Promise<AnimationSetting> {
    return this.getListSetting("animation", true)
  }

  private async setAnimation(animated: AnimationSetting): Promise<void> {
    if (animated === await this.getAnimation()) {
      this.animated = animated
      this.events.publish("settingsChanged", { section: "animation" })
      return
    }
    await this.setListSetting("animation", animated)
    this.animated = animated
    this.events.publish("settingsChanged", { section: "animation" })
  }

  private async addFilter(filter: string): Promise<void> {
    const filterList = await this.getFilterList()
    filterList.push(filter)
    await this.saveFilterList(filterList)
  }

  private async refreshRedirects(): Promise<void> {
    const redirects = await this.getRedirectList()
    URLRedirect.setRedirects(redirects)
    //setRedirects drops the rewritten -> original lookup, rebuild it
    this.stories.forEach((story) => URLRedirect.redirect_url(story.href))
    this.events.publish("redirectsChanged", { redirects })
  }

  private async refilterStories(): Promise<void> {
    const filterList = await this.getFilterList()
    for (const story of this.stories.values()) {
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
    const groupedSources = groupStorySources(await this.getStorySources())
    const processingSources = new Map<string, ProcessingSource>()
    const promises: Promise<void>[] = []

    for (const groupName in groupedSources) {
      this.menuGroups.add(groupName)
      for (const sourceUrl of groupedSources[groupName]) {
        const sourceInfo = this.getDomainAndParserType(sourceUrl)
        if (sourceInfo.parserType !== "Unknown") {
          this.menuTypes.add(sourceInfo.parserType)
        }
        processingSources.set(sourceUrl, sourceInfo)
        this.emitLoader(processingSources)
        promises.push(
          this.loadSource(sourceUrl, tryCache)
            .then(async (stories) => {
              await this.processStoryInput(stories, groupName)
            })
            .catch((error) => {
              this.reportLoadError(sourceUrl, error)
            })
            .finally(() => {
              processingSources.delete(sourceUrl)
              this.emitLoader(processingSources)
            })
        )
      }
    }

    this.emitMenuChanged()
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

    const filterList = await this.getFilterList()
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

  private async loadSource(
    sourceUrl: string,
    tryCache = true
  ): Promise<Story[] | undefined> {
    let url = sourceUrl
    let cached: unknown = null

    if (tryCache) {
      cached = await this.getCached(sourceUrl)
    }

    const parser = StoryParser.get_parser_for_url(url)
    if (!parser) {
      this.setSourceError({
        url: sourceUrl,
        title: "No Handler",
        message:
          "No handler available for this source type. You may need to add a custom parser.",
        type: "warning"
      })
      return
    }

    const originalUrl = url
    if (parser.resolve_url) {
      url = parser.resolve_url(url)
    }

    if (cached != null) {
      try {
        if (parser.options.collects == "dom") {
          cached = StoryParser.parse_dom(cached as string, url)
        } else if (parser.options.collects == "xml") {
          cached = StoryParser.parse_xml(cached as string)
        }
        return parser.parse(cached as Record<string, unknown> | Document, url, originalUrl) || []
      } catch (parseError) {
        const detail =
          parseError instanceof Error ? parseError.message : String(parseError)
        throw new Error(`Parsing failed: ${detail}`)
      }
    }

    const response = await this.platform.fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }

    return (
      StoryParser.parse_response(response, url, originalUrl, {
        cacheResult: (cacheUrl, content) =>
          this.platform.cacheStore?.set(cacheUrl, content) || Promise.resolve()
      }) || []
    )
  }

  private async getCached(url: string): Promise<unknown> {
    if (!this.platform.cacheStore) return null

    const cached = await this.platform.cacheStore.get(url)
    if (!cached) return null

    try {
      if (!Array.isArray(cached)) {
        throw new Error("cached entry is not Array")
      }
      if (cached.length != 2) {
        throw new Error("cached entry not length 2")
      }
      const minsOld = (Date.now() - cached[0]) / (60 * 1000)
      if (minsOld > await this.getCacheTime()) {
        throw new Error(`cached entry out of date ${minsOld}`)
      }
    } catch (error) {
      console.log("cache error: ", error)
      return null
    }

    return cached[1]
  }

  private getDomainAndParserType(sourceUrl: string): ProcessingSource {
    const parser = StoryParser.get_parser_for_url(sourceUrl)
    let resolvedUrl = sourceUrl
    if (parser && parser.resolve_url) {
      resolvedUrl = parser.resolve_url(sourceUrl)
    }

    let domain = "source"
    try {
      domain = new URL(resolvedUrl).hostname.replace("www.", "")
    } catch {
      domain = resolvedUrl.substring(0, 20)
    }

    return {
      domain,
      parserType: parser?.options.type || "Unknown"
    }
  }

  private reportLoadError(sourceUrl: string, error: unknown): void {
    console.error(error)
    const detail = error instanceof Error ? error.message : String(error)
    let title = "Failed"
    let errorDetail = detail

    if (detail.includes("Parsing failed:")) {
      title = "Parse Error"
      errorDetail = detail.replace("Parsing failed: ", "")
    } else if (detail.includes("JSON parsing failed:")) {
      title = "JSON Error"
      errorDetail = detail.replace("JSON parsing failed: ", "")
    } else if (detail.includes("DOM parsing failed:")) {
      title = "DOM Error"
      errorDetail = detail.replace("DOM parsing failed: ", "")
    } else if (detail.includes("XML parsing failed:")) {
      title = "XML Error"
      errorDetail = detail.replace("XML parsing failed: ", "")
    } else if (detail.includes("HTTP 404")) {
      title = "Not Found"
      errorDetail = "The requested resource was not found"
    } else if (detail.includes("HTTP")) {
      title = "HTTP Error"
    }

    this.setSourceError({
      url: sourceUrl,
      title,
      message: errorDetail,
      type: "error",
      details: errorDetails(error)
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

  private setStory(href: string, story: Story, quiet = false): Story {
    Story.assertIngestible(story)
    if (href !== story.href) {
      throw new Error("Story map key does not match its URL")
    }
    const oldStory = this.stories.get(href)
    this.stories.set(href, story)
    //prime the rewritten -> original lookup used by findStoryByUrl
    URLRedirect.redirect_url(story.href)
    if (story.comment_url) {
      this.comments.set(story.comment_url, story.href)
    }
    story.substories.forEach((substory) => {
      if (substory.comment_url) {
        this.comments.set(substory.comment_url, story.href)
      }
    })

    if (!quiet) {
      this.emitDataChange([href], story, oldStory, null)
    }
    return story
  }

  private addStoryToWorkingSet(story: Story): void {
    this.setStory(story.href, story, true)
    this.events.publish("storiesChanged", {
      stories: [story],
      bucket: typeof story.bucket === "string" ? story.bucket : "stories"
    })
  }

  private removeStoryFromWorkingSet(href: string): void {
    const removed = this.stories.delete(href)
    for (const [url, storyHref] of this.comments) {
      if (storyHref === href) this.comments.delete(url)
    }
    if (removed) {
      this.events.publish("storyRemoved", { href })
    }
  }

  private getStory(href: string): Story | undefined {
    return this.stories.get(href)
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
    return Array.from(this.stories.values()).filter((story) => story.stared)
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
    const previousWrite = this.storyWrites.get(href)
    const waitForPrevious = previousWrite
      ? previousWrite.then(
        () => undefined,
        () => undefined
      )
      : Promise.resolve()
    const write = waitForPrevious.then(task)
    this.storyWrites.set(href, write)
    const settle = () => {
      if (this.storyWrites.get(href) === write) {
        this.storyWrites.delete(href)
      }
    }
    write.then(settle, (error) => {
      settle()
      // Many UI callers fire and forget; keep failed saves visible.
      console.error(`${failure.message}: ${href}`, error)
      this.reportDiagnostic({
        severity: "error",
        operation: failure.operation,
        message: failure.message,
        storyUrl: href,
        details: errorDetails(error)
      })
    })
    return write
  }

  // Resolves once every story write queued so far has settled; save failures
  // are already logged by queueStoryWrite, so they do not reject here.
  private async settledStoryWrites(): Promise<void> {
    while (this.storyWrites.size > 0) {
      await Promise.allSettled(Array.from(this.storyWrites.values()))
    }
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
    const workingStory = this.getStory(newStory.href)
    let oldStory: Story | null | undefined = workingStory ?? storedStory

    if (!oldStory) {
      newStory = this.setStory(newStory.href.toString(), newStory)
      return this.platform.storyStore.saveStory(newStory)
    }

    // A story returned to a caller for presentation must also be present in
    // the authoritative working set. Previously a stored story could be
    // returned to StoryList without being registered here. A later sync then
    // looked like a new insertion, which StoryList deduplicated against its
    // stale row instead of updating it.
    if (!workingStory) {
      oldStory = this.setStory(oldStory.href, oldStory, true)
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
    if (this.stories.size === 0) {
      const stored = await this.platform.storyStore.getStories(500)
      stored.forEach((story) => this.setStory(story.href, story, true))
    }
    return Array.from(this.stories.values())
  }

  private async findStoryByUrl(url: string): Promise<Story | null> {
    const story = this.lookupStory(url)
    if (story) {
      return story
    }
    //the url might be the rewritten form of a story href
    const original = URLRedirect.original_url(url)
    if (original !== url) {
      const rewritten = this.lookupStory(original)
      if (rewritten) return rewritten
    }
    const stored = await this.platform.storyStore.getStory(original)
    if (stored) return this.setStory(stored.href, stored, true)
    await this.getWorkingStories()
    return this.lookupStory(url) ?? this.lookupStory(URLRedirect.original_url(url))
  }

  private lookupStory(url: string): Story | null {
    const story = this.stories.get(url)
    if (story) {
      return story
    }
    const commentHref = this.comments.get(url)
    if (commentHref) {
      return this.stories.get(commentHref) ?? null
    }
    return null
  }

  private async persistStoryChange(
    href: string,
    path: string,
    value: Story | string | boolean
  ): Promise<Story | undefined> {
    let story = this.getStory(href)
    if (!story) {
      const stored = await this.platform.storyStore.getStory(href)
      if (stored) story = this.setStory(stored.href, stored, true)
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
      const current = this.getStory(href)
      if (current === story) {
        story._id = saved._id
        story._rev = saved._rev
      } else if (current) {
        const reconciled = mergeStorySyncState(current, saved)
        reconciled._id = saved._id
        reconciled._rev = saved._rev
        this.setStory(href, reconciled)
      } else {
        this.setStory(href, saved)
      }
      return this.getStory(href) ?? saved
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
    this.removeStoryFromWorkingSet(href)
  }

  private emitDataChange(
    path: string[],
    value: unknown,
    previousValue: unknown,
    name: string | null
  ): void {
    const story = path.length > 0 ? this.stories.get(path[0]) : undefined
    if (!story) return

    const detail: StoryChangeDetail = {
      story,
      path,
      value,
      previousValue,
      name,
      animated: this.animated
    }
    this.events.publish("storyChanged", detail)
  }

  private reportDiagnostic(error: DiagnosticError): void {
    const key = JSON.stringify(error)
    if (this.diagnosticKeys.has(key)) return
    this.diagnosticKeys.add(key)
    this.diagnostics.push(error)
    this.events.publish("diagnosticError", error)
  }

  private reportStartupSettingError(setting: string, error: unknown): void {
    this.reportDiagnostic({
      severity: "error",
      operation: `settings.load.${setting}`,
      message: `The ${setting} setting could not be loaded; using defaults`,
      details: errorDetails(error)
    })
  }

  private async selectUrl(url: string): Promise<void> {
    this.events.publish("selectedUrlChanged", { url })
  }

  private openUrl(url: string, target: string): void {
    if (url.startsWith("search:")) {
      this.events.publish("searchRequested", {
        query: url.substring("search:".length)
      })
      return
    }

    this.platform.activeTab?.openUrl(url, target)
  }

  private handleDatabaseChange(change: DatabaseChange): void {
    const pendingValue = this.pendingSettingWrites.get(change.id)
    if (
      pendingValue !== undefined &&
      JSON.stringify(change.doc?.list) === pendingValue
    ) {
      this.pendingSettingWrites.delete(change.id)
      return
    }

    switch (change.id) {
      case "story_sources":
        this.events.publish("settingsChanged", { section: "sources" })
        this.client.reloadStories(true)
        break
      case "filter_list":
        this.events.publish("settingsChanged", { section: "filters" })
        this.refilterStories()
        break
      case "redirect_list":
        this.refreshRedirects()
        this.events.publish("settingsChanged", { section: "redirects" })
        break
      case "theme":
        this.client.getTheme().then((theme) => this.platform.theme.setTheme(theme))
        this.events.publish("settingsChanged", { section: "theme" })
        break
      case "animation":
        this.client.getAnimation().then((animated) => {
          this.animated = animated
          this.events.publish("settingsChanged", { section: "animation" })
        })
        break
    }
  }

  private async handleObservedStoryChange(
    change: DatabaseChange
  ): Promise<void> {
    if (change.doc?._deleted) {
      this.removeStoryFromWorkingSet(change.id.substring("sto_".length))
      return
    }
    if (!change.doc) return

    const changedStory = Story.from_obj(change.doc)
    const currentStory = this.getStory(changedStory.href)
    if (!currentStory) return

    const storedStory = await this.platform.storyStore.getStory(
      changedStory.href
    )
    if (!storedStory) {
      this.removeStoryFromWorkingSet(changedStory.href)
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
      this.setStory(effectiveStory.href, effectiveStory)
    }
  }

  private async handleRemoteDatabaseChange(
    change: DatabaseChange
  ): Promise<void> {
    if (!change.id.startsWith("sto_") || !change.doc) return

    if (change.doc._deleted) {
      this.removeStoryFromWorkingSet(change.id.substring("sto_".length))
      return
    }

    const remoteStory = Story.from_obj(change.doc)
    const currentStory = this.getStory(remoteStory.href)
    const localStory = await this.platform.storyStore.getStory(remoteStory.href)
    const mergeBase = currentStory ?? localStory ?? remoteStory
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
        this.setStory(effectiveStory.href, effectiveStory)
      }
      return
    }

    if (change.presentation !== "background") {
      this.addStoryToWorkingSet(effectiveStory)
    }
  }
}

const syncedStoryFields = ["read_state", "stared", "filter"] as const

function mergeStorySyncState(local: Story, remote: Story): Story {
  const merged = Story.from_obj(local.to_obj())
  const timestamps = { ...local.sync_updated_at }

  syncedStoryFields.forEach((field) => {
    const localTime = local.sync_updated_at?.[field] ?? 0
    const remoteTime = remote.sync_updated_at?.[field] ?? 0
    const useRemote =
      remoteTime > localTime ||
      (remoteTime === localTime &&
        legacyStoryFieldRank(field, remote[field]) >
          legacyStoryFieldRank(field, local[field]))
    if (useRemote) merged[field] = remote[field] as never
    const latest = Math.max(localTime, remoteTime)
    if (latest > 0) timestamps[field] = latest
  })

  if (Object.keys(timestamps).length > 0) {
    merged.sync_updated_at = timestamps
  }
  return merged
}

function legacyStoryFieldRank(
  field: typeof syncedStoryFields[number],
  value: unknown
): number {
  if (field === "read_state") {
    if (value === "skipped") return 2
    if (value === "read") return 1
    return 0
  }
  if (field === "stared") return value === true ? 1 : 0
  return typeof value === "string" && value ? 1 : 0
}

function sameStorySyncState(a: Story, b: Story): boolean {
  if (!syncedStoryFields.every((field) => a[field] === b[field])) return false
  const aUpdates = a.sync_updated_at ?? {}
  const bUpdates = b.sync_updated_at ?? {}
  const updateFields = new Set([
    ...Object.keys(aUpdates),
    ...Object.keys(bUpdates)
  ])
  return Array.from(updateFields).every(
    (field) => aUpdates[field] === bUpdates[field]
  )
}

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return [error.name + ": " + error.message, error.stack]
    .filter(Boolean)
    .join("\n")
}

export function createOnceApp(platform: OncePlatformPorts): OnceApp {
  return new OnceApp(platform)
}
