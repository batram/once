import * as StoryParser from "../parser/parser"
import { StoryMap } from "./StoryMap"
import { Story } from "./Story"
import * as story_filters from "./StoryFilters"
import { CacheStore } from "@once/platform-webext"
import { BackComms } from "@once/platform-webext"
import { OnceSettings } from "../OnceSettings"

async function get_cached(url: string) {
  const cached = await CacheStore.get(url)

  if (!cached) return null

  try {
    if (!Array.isArray(cached)) {
      throw new Error("cached entry is not Array")
    }
    if (cached.length != 2) {
      throw new Error("cached entry not length 2")
    }
    const mins_old = (Date.now() - cached[0]) / (60 * 1000)
    if (mins_old > await OnceSettings.instance.get_cache_time()) {
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

  BackComms.send("loader_insights", "reset_errors")

  const updateProcessing = () => {
    BackComms.send(
      "loader_insights",
      "show_processing",
      Array.from(processingSources.values())
    )
  }

  // Clear previous source errors
  BackComms.send("settings", "clear_source_errors")

  for (const group_name in story_groups) {
    BackComms.send("menu", "add_group", group_name)
    const group = story_groups[group_name]
    group.map((source_entry) => {
      const sourceInfo = getDomainAndParserType(source_entry)
      if (sourceInfo.parserType != "Unknown") {
        BackComms.send("menu", "add_type", sourceInfo.parserType)
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

            BackComms.send(
              "settings",
              "add_source_error",
              source_entry,
              errorDetail,
              "error"
            )
            BackComms.send(
              "loader_insights",
              "show_error",
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
  BackComms.send("loader_insights", "hide")
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
  const filtered_stories = await story_filters.filter_stories(stories)
  const all_stories = filtered_stories.sort()
  all_stories.forEach((story) => {
    story.tags.push({
      class: "group",
      text: "*" + group_name,
      href: "search:" + "*" + group_name
    })
  })
  StoryMap.remote.stories_loaded(all_stories, "stories")
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

    BackComms.send("settings", "add_source_error", url, message, "warning")
    BackComms.send("loader_insights", "show_error", "No Handler", url, message)

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
            cacheResult: (cacheUrl, content) => CacheStore.set(cacheUrl, content)
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
