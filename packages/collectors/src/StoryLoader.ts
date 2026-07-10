import * as StoryParser from "./parser"
import { filter_stories, OnceSettings, Story, StoryMap } from "@once/core"

export interface StoryLoaderCacheAdapter {
  get(url: string): Promise<unknown>
  set(url: string, content: unknown): Promise<void>
}

export interface StoryLoaderUiAdapter {
  resetErrors(): void
  showProcessing(sources: { domain: string; parserType: string }[]): void
  clearSourceErrors(): void
  addGroup(groupName: string): void
  addType(parserType: string): void
  addSourceError(
    url: string,
    message: string,
    level: "warning" | "error"
  ): void
  showError(
    errorType: string,
    url: string,
    message: string,
    sourceInfo?: { domain: string; parserType: string }
  ): void
  hideInsights(): void
}

export interface StoryLoaderAdapters {
  cache?: StoryLoaderCacheAdapter
  ui?: Partial<StoryLoaderUiAdapter>
  storiesLoaded?: (stories: Story[], bucket: string) => void
}

const noopUiAdapter: StoryLoaderUiAdapter = {
  resetErrors() {},
  showProcessing() {},
  clearSourceErrors() {},
  addGroup() {},
  addType() {},
  addSourceError() {},
  showError() {},
  hideInsights() {}
}

const adapters: {
  cache?: StoryLoaderCacheAdapter
  ui: StoryLoaderUiAdapter
  storiesLoaded: (stories: Story[], bucket: string) => void
} = {
  ui: noopUiAdapter,
  storiesLoaded: (stories, bucket) =>
    StoryMap.instance?.stories_loaded(stories, bucket)
}

export function configureStoryLoader(nextAdapters: StoryLoaderAdapters): void {
  if (nextAdapters.cache !== undefined) {
    adapters.cache = nextAdapters.cache
  }
  if (nextAdapters.ui) {
    adapters.ui = { ...adapters.ui, ...nextAdapters.ui }
  }
  if (nextAdapters.storiesLoaded) {
    adapters.storiesLoaded = nextAdapters.storiesLoaded
  }
}

async function get_cached(url: string) {
  if (!adapters.cache) return null

  const cached = await adapters.cache.get(url)

  if (!cached) return null

  try {
    if (!Array.isArray(cached)) {
      throw new Error("cached entry is not Array")
    }
    if (cached.length != 2) {
      throw new Error("cached entry not length 2")
    }
    const mins_old = (Date.now() - cached[0]) / (60 * 1000)
    if (
      OnceSettings.instance &&
      "get_cache_time" in OnceSettings.instance &&
      mins_old > await (OnceSettings.instance as any).get_cache_time()
    ) {
      throw new Error(`cached entry out of date ${mins_old}`)
    } else {
      console.log("cached", mins_old, url)
    }
  } catch (e) {
    console.log("cache error: ", e)
    return null
  }

  return cached[1]
}

export async function parallel_load_stories(
  story_groups: Record<string, string[]>,
  try_cache = true
): Promise<void> {
  const promises: Promise<void>[] = []
  const processingSources = new Map<
    string,
    { domain: string; parserType: string }
  >()

  adapters.ui.resetErrors()

  const updateProcessing = () => {
    adapters.ui.showProcessing(Array.from(processingSources.values()))
  }

  // Clear previous source errors
  adapters.ui.clearSourceErrors()

  for (const group_name in story_groups) {
    adapters.ui.addGroup(group_name)
    const group = story_groups[group_name]
    group.map((source_entry) => {
      const sourceInfo = getDomainAndParserType(source_entry)
      if (sourceInfo.parserType != "Unknown") {
        adapters.ui.addType(sourceInfo.parserType)
      }
      processingSources.set(source_entry, sourceInfo)
      updateProcessing()
      promises.push(
        cache_load(source_entry, try_cache)
          .then((stories) => {
            process_story_input(stories, group_name)
          })
          .catch((e) => {
            console.error(e)
            const detail = e instanceof Error ? e.message : String(e)
            const { domain, parserType } = getDomainAndParserType(source_entry)

            let errorType = "Failed"
            let errorDetail = detail

            // Categorize error types for better user understanding
            if (detail.includes("Parsing failed:")) {
              errorType = "Parse Error"
              errorDetail = detail.replace("Parsing failed: ", "")
            } else if (detail.includes("JSON parsing failed:")) {
              errorType = "JSON Error"
              errorDetail = detail.replace("JSON parsing failed: ", "")
            } else if (detail.includes("DOM parsing failed:")) {
              errorType = "DOM Error"
              errorDetail = detail.replace("DOM parsing failed: ", "")
            } else if (detail.includes("XML parsing failed:")) {
              errorType = "XML Error"
              errorDetail = detail.replace("XML parsing failed: ", "")
            } else if (detail.includes("HTTP 404")) {
              errorType = "Not Found"
              errorDetail = "The requested resource was not found"
            } else if (detail.includes("HTTP")) {
              errorType = "HTTP Error"
              errorDetail = detail
            }
            adapters.ui.addSourceError(source_entry, errorDetail, "error")
            adapters.ui.showError(
              errorType,
              source_entry,
              `Source: ${source_entry}\nError: ${errorDetail}`,
              { domain, parserType }
            )
          })
          .finally(() => {
            processingSources.delete(source_entry)
            updateProcessing()
          })
      )
    })
  }

  try {
    await Promise.all(promises)
  } catch (e) {
    console.error(e)
  }
  adapters.ui.hideInsights()
}

export const parallelLoadStories = parallel_load_stories

function getDomainAndParserType(sourceUrl: string): {
  domain: string
  parserType: string
} {
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

async function process_story_input(stories: Story[], group_name: string) {
  if (!stories) {
    return
  }
  const filtered_stories = await filter_stories(stories)
  const all_stories = filtered_stories.sort()
  all_stories.forEach((story) => {
    story.tags.push({
      class: "group",
      text: "*" + group_name,
      href: "search:" + "*" + group_name
    })
  })
  adapters.storiesLoaded(all_stories, "stories")
}

//data loader
async function cache_load(url: string, try_cache = true) {
  let cached = null
  if (try_cache) {
    cached = await get_cached(url)
  }

  const parser = StoryParser.get_parser_for_url(url)
  if (!parser) {
    const message =
      "No handler available for this source type. You may need to add a custom parser."

    adapters.ui.addSourceError(url, message, "warning")
    adapters.ui.showError("No Handler", url, message)

    return
  }

  const og_url = url

  if (parser && parser.resolve_url) {
    url = parser.resolve_url(url)
  }

  if (cached != null) {
    try {
      if (parser.options.collects == "dom") {
        cached = StoryParser.parse_dom(cached, url)
      } else if (parser.options.collects == "xml") {
        cached = StoryParser.parse_xml(cached)
      }
      return parser.parse(cached) || []
    } catch (parseError) {
      const detail =
        parseError instanceof Error ? parseError.message : String(parseError)
      throw new Error(`Parsing failed: ${detail}`)
    }
  } else {
    try {
      const resp = await fetch(url)
      if (resp.ok) {
        return (
          StoryParser.parse_response(resp, url, og_url, {
            cacheResult: (cacheUrl, content) =>
              adapters.cache?.set(cacheUrl, content) || Promise.resolve()
          }) || []
        )
      } else {
        throw new Error(`HTTP ${resp.status}: ${resp.statusText}`)
      }
    } catch (fetchError) {
      if (
        fetchError instanceof Error &&
        fetchError.message.startsWith("Parsing failed:")
      ) {
        throw fetchError // Re-throw parsing errors as-is
      }
      throw fetchError // Re-throw network errors as-is
    }
  }
}

export async function load(
  story_groups: Record<string, string[]>
): Promise<void> {
  const cache = false
  parallelLoadStories(story_groups, cache)
}
