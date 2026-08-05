import { Story, StorySource } from "@once/core"
import * as StoryParser from "@once/collectors"
import { CacheStorePort, ProcessingSource, SourceError } from "./types"

export class SourceLoader {
  constructor(
    private readonly fetch: typeof globalThis.fetch,
    private readonly cache: CacheStorePort | undefined,
    private readonly getCacheTime: () => Promise<number>,
    private readonly reportError: (error: SourceError) => void
  ) {}

  async load(
    source: StorySource,
    tryCache = true
  ): Promise<Story[] | undefined> {
    // Resolved before anything else, because the URL to fetch is also the cache
    // key. Reading the cache under the source line while writing it under the
    // resolved URL is why a configurable source never once hit its cache.
    const resolved = StoryParser.resolveStorySource(source)
    if (!StoryParser.isResolved(resolved)) {
      const noHandler = resolved.kind === "no-handler"
      this.reportError({
        sourceId: source.id,
        url: source.url,
        title: noHandler ? "No Handler" : "Config Error",
        message: noHandler
          ? `${resolved.problem}. You may need to add a custom parser.`
          : resolved.problem,
        type: noHandler ? "warning" : "error"
      })
      return
    }

    const { collector, url } = resolved
    const context = { url, config: resolved.config }
    let cached: unknown = tryCache ? await this.getCached(url) : null
    if (cached != null) {
      try {
        if (collector.options.collects == "dom") {
          cached = StoryParser.parse_dom(cached as string, url)
        } else if (collector.options.collects == "xml") {
          cached = StoryParser.parse_xml(cached as string)
        }
        return collector.parse(
          cached as Record<string, unknown> | Document,
          context
        ) || []
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error)
        throw new Error(`Parsing failed: ${detail}`)
      }
    }

    const response = await this.fetch(url)
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`)
    }
    return StoryParser.parse_response(response, resolved, {
      cacheResult: (cacheUrl, content) =>
        this.cache?.set(cacheUrl, content) || Promise.resolve()
    }) || []
  }

  describe(source: StorySource): ProcessingSource {
    const resolved = StoryParser.resolveStorySource(source)
    const url = StoryParser.isResolved(resolved) ? resolved.url : source.url
    let domain = "source"
    try {
      domain = new URL(url).hostname.replace("www.", "")
    } catch {
      domain = url.substring(0, 20)
    }
    return {
      domain,
      parserType: StoryParser.isResolved(resolved)
        ? resolved.collector.options.type
        : "Unknown"
    }
  }

  reportLoadFailure(source: StorySource, error: unknown): void {
    console.error(error)
    const detail = error instanceof Error ? error.message : String(error)
    let title = "Failed"
    let message = detail
    if (detail.includes("Parsing failed:")) {
      title = "Parse Error"
      message = detail.replace("Parsing failed: ", "")
    } else if (detail.includes("JSON parsing failed:")) {
      title = "JSON Error"
      message = detail.replace("JSON parsing failed: ", "")
    } else if (detail.includes("DOM parsing failed:")) {
      title = "DOM Error"
      message = detail.replace("DOM parsing failed: ", "")
    } else if (detail.includes("XML parsing failed:")) {
      title = "XML Error"
      message = detail.replace("XML parsing failed: ", "")
    } else if (detail.includes("HTTP 404")) {
      title = "Not Found"
      message = "The requested resource was not found"
    } else if (detail.includes("HTTP")) {
      title = "HTTP Error"
    }
    this.reportError({
      sourceId: source.id,
      url: source.url,
      title,
      message,
      type: "error",
      details: errorDetails(error)
    })
  }

  private async getCached(url: string): Promise<unknown> {
    if (!this.cache) return null
    const cached = await this.cache.get(url)
    if (!cached) return null
    try {
      if (!Array.isArray(cached)) throw new Error("cached entry is not Array")
      if (cached.length != 2) throw new Error("cached entry not length 2")
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
}

function errorDetails(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  return [error.name + ": " + error.message, error.stack]
    .filter(Boolean)
    .join("\n")
}
