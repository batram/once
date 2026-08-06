import { Story, StorySource } from "@once/core"
import * as StoryParser from "@once/collectors"
import {
  CachePolicy,
  CacheStorePort,
  ProcessingSource,
  SourceError
} from "./types"
import { DEFAULT_CACHE_MINUTES } from "./cacheTiming"

export interface SourceLoadOptions {
  /** "network-only" skips the cache read; it still writes what it fetches. */
  policy: CachePolicy
  /** This source's window, already resolved through the timing precedence. */
  cacheMinutes: number
}

export class SourceLoader {
  constructor(
    private readonly fetch: typeof globalThis.fetch,
    private readonly cache: CacheStorePort | undefined,
    private readonly reportError: (error: SourceError) => void,
    /** Injected so the expiry boundary is testable without waiting for it. */
    private readonly now: () => number = () => Date.now()
  ) {}

  async load(
    source: StorySource,
    options: SourceLoadOptions = {
      policy: "cache-first",
      cacheMinutes: DEFAULT_CACHE_MINUTES
    }
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
    let cached: unknown = options.policy === "cache-first"
      ? await this.getCached(url, options.cacheMinutes)
      : null
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

  private async getCached(url: string, cacheMinutes: number): Promise<unknown> {
    if (!this.cache) return null
    // A zero window means always refetch, so the entry is not even read. The
    // old comparison asked whether the entry was older than the window, which
    // an entry written milliseconds ago is not, so zero used to serve a hit.
    if (cacheMinutes <= 0) return null
    const cached = await this.cache.get(url)
    if (!cached) return null
    try {
      if (!Array.isArray(cached)) throw new Error("cached entry is not Array")
      if (cached.length != 2) throw new Error("cached entry not length 2")
      const stamped = cached[0]
      if (typeof stamped !== "number" || !Number.isFinite(stamped)) {
        throw new Error(`cached entry has no timestamp: ${String(stamped)}`)
      }
      // Integer milliseconds, and the boundary belongs to the expired side: an
      // entry exactly N minutes old is out of date.
      const ageMs = this.now() - stamped
      if (!(ageMs < cacheMinutes * 60_000)) {
        throw new Error(`cached entry out of date ${ageMs / 60_000}`)
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
