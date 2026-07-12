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
  OnceClient,
  OnceEventHandler,
  OnceEventName,
  OncePlatformPorts,
  ProcessingSource,
  SourceError,
  StoryChangeDetail,
  ThemeName
} from "./types"
import { LocalEventBus } from "./EventBus"

export class OnceApp {
  readonly client: OnceClient
  private readonly events = new LocalEventBus()
  private readonly stories = new Map<string, Story>()
  private readonly comments = new Map<string, string>()
  private readonly sourceErrors = new Map<string, SourceError>()
  private readonly menuGroups = new Set<string>()
  private readonly menuTypes = new Set<string>([
    "ALL",
    "filtered",
    "stared",
    "new"
  ])
  private internalMapReady = false
  private animated = true

  constructor(private platform: OncePlatformPorts) {
    this.client = this.createClient()
  }

  async start(): Promise<void> {
    this.platform.onDatabaseChange?.((change) => {
      this.handleDatabaseChange(change)
    })

    const storedStories = await this.platform.storyStore.getStories()
    storedStories.forEach((story) => this.setStory(story.href, story, true))
    this.internalMapReady = true

    this.animated = await this.getAnimation()
    this.platform.theme.setTheme(await this.getTheme())
    await this.refreshRedirects()

    const syncUrl = await this.getSyncUrl()
    if (syncUrl) {
      this.platform.syncService?.syncFrom(syncUrl)
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
      findStoryByUrl: async (url) => this.findStoryByUrl(url),
      persistStoryChange: (href, path, value) =>
        this.persistStoryChange(href, path, value),
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
    return this.platform.listStore.get("story_sources", defaultSources)
  }

  private async saveStorySources(storySources: string[]): Promise<void> {
    await this.platform.listStore.set("story_sources", storySources)
    this.events.publish("settingsChanged", { section: "sources" })
    await this.reloadStories(true)
  }

  private async getFilterList(): Promise<string[]> {
    return this.platform.listStore.get("filter_list", defaultFilterList)
  }

  private async saveFilterList(filterList: string[]): Promise<void> {
    await this.platform.listStore.set("filter_list", filterList)
    this.events.publish("settingsChanged", { section: "filters" })
    await this.refilterStories()
  }

  private async getRedirectList(): Promise<Redirect[]> {
    return this.platform.listStore.get("redirect_list", defaultRedirectList)
  }

  private async saveRedirectList(redirectList: Redirect[]): Promise<void> {
    await this.platform.listStore.set("redirect_list", redirectList)
    await this.refreshRedirects()
    this.events.publish("settingsChanged", { section: "redirects" })
  }

  private getSyncUrl(): Promise<string> {
    return this.platform.syncSettingsStore.getSyncUrl()
  }

  private async setSyncUrl(syncUrl: string): Promise<void> {
    const oldUrl = await this.getSyncUrl()
    if (syncUrl !== oldUrl) {
      await this.platform.syncSettingsStore.setSyncUrl(syncUrl)
      this.platform.syncService?.syncFrom(syncUrl)
    }
    this.events.publish("settingsChanged", { section: "sync" })
  }

  private getCacheTime(): Promise<number> {
    return this.platform.syncSettingsStore.getCacheTime()
  }

  private async setCacheTime(cacheTime: string): Promise<void> {
    const parsedCacheTime = parseInt(cacheTime)
    if (parsedCacheTime === await this.getCacheTime()) {
      this.events.publish("settingsChanged", { section: "cache" })
      return
    }
    await this.platform.syncSettingsStore.setCacheTime(cacheTime)
    this.events.publish("settingsChanged", { section: "cache" })
  }

  private getTheme(): Promise<ThemeName> {
    return this.platform.listStore.get("theme", "dark" as ThemeName)
  }

  private async setTheme(theme: ThemeName): Promise<void> {
    if (theme === await this.getTheme()) {
      this.platform.theme.setTheme(theme)
      this.events.publish("settingsChanged", { section: "theme" })
      return
    }
    await this.platform.listStore.set("theme", theme)
    this.platform.theme.setTheme(theme)
    this.events.publish("settingsChanged", { section: "theme" })
  }

  private getAnimation(): Promise<AnimationSetting> {
    return this.platform.listStore.get("animation", true)
  }

  private async setAnimation(animated: AnimationSetting): Promise<void> {
    if (animated === await this.getAnimation()) {
      this.animated = animated
      this.events.publish("settingsChanged", { section: "animation" })
      return
    }
    await this.platform.listStore.set("animation", animated)
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
      type: "error"
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

  private getStory(href: string): Story | undefined {
    return this.stories.get(href)
  }

  private async addStories(stories: Story[]): Promise<Story[]> {
    return Promise.all(stories.map((story) => this.addStory(story)))
  }

  private getAllStared(): Story[] {
    return Array.from(this.stories.values()).filter((story) => story.stared)
  }

  private async addStory(newStory: Story, bucket = "stories"): Promise<Story> {
    if (!(newStory instanceof Story)) {
      throw new Error("Please, only add Story instances")
    }
    Story.assertIngestible(newStory)

    newStory.bucket = bucket
    let oldStory: Story | null | undefined

    if (this.internalMapReady) {
      oldStory = this.getStory(newStory.href)
    } else {
      oldStory = await this.platform.storyStore.getStory(newStory.href)
    }

    if (!oldStory) {
      newStory = this.setStory(newStory.href.toString(), newStory)
      return this.platform.storyStore.saveStory(newStory)
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

  private findStoryByUrl(url: string): Story | null {
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
    if (story) {
      const previousValue = story[path]
      story[path] = value
      this.emitDataChange([href, path], value, previousValue, null)
      story = await this.platform.storyStore.saveStory(story)
    }
    return story
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
    if (change.id.startsWith("sto_") && change.doc) {
      const changedStory = Story.from_obj(change.doc)
      const stored = this.getStory(changedStory.href)
      if (!stored || !stored._rev || stored._rev != change.doc._rev) {
        this.setStory(changedStory.href, changedStory)
      }
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
}

export function createOnceApp(platform: OncePlatformPorts): OnceApp {
  return new OnceApp(platform)
}
