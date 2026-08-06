/**
 * Per-source cache timing.
 *
 * A slow blog need not be refetched as often as Hacker News, so how long a
 * fetched body stays fresh is answered per source rather than once for the whole
 * app. Four layers can have an opinion and the most specific one wins:
 *
 *   source override → user collector override → shipped collector default →
 *   global default
 *
 * The user's per-collector overrides live in their own versioned document so a
 * collector's window survives a source being edited, deleted, or re-added; there
 * is deliberately no per-source map, because a source already carries its own
 * `cacheMinutes`.
 *
 * This lives here rather than in core because resolving which collector handles
 * a source needs the collector registry.
 */

import { isCacheMinutes, StorySource } from "@once/core"
import { get_parser_by_id, get_parser_for_url } from "@once/collectors"

export const CACHE_TIMING_DOCUMENT_ID = "cache_timing"
export const CACHE_TIMING_VERSION = 1

/** The global default, and the fallback when a stored one is unreadable. */
export const DEFAULT_CACHE_MINUTES = 120

export interface CacheTimingDocument {
  version: number
  /** Collector id to minutes. `0` means always refetch. */
  collectors: Record<string, number>
}

export function emptyCacheTimingDocument(): CacheTimingDocument {
  return { version: CACHE_TIMING_VERSION, collectors: {} }
}

/**
 * Tolerant read, because another client wrote this. An unreadable document
 * yields no overrides rather than an error: every layer below it still answers,
 * so the worst case is the previous timing, not a broken reload. Unknown
 * collector ids are kept — a newer build may ship that collector, and this
 * reader never writes back, so keeping them cannot lose anybody's data.
 */
export function readCacheTimingDocument(value: unknown): CacheTimingDocument {
  const document = emptyCacheTimingDocument()
  if (!value || typeof value !== "object" || Array.isArray(value)) return document
  const input = value as Partial<CacheTimingDocument>
  // A newer version means fields this build cannot interpret. Reading it as if
  // it were version 1 would apply windows that may since have changed meaning.
  if (input.version !== CACHE_TIMING_VERSION) return document
  if (!input.collectors || typeof input.collectors !== "object") return document
  for (const [id, minutes] of Object.entries(input.collectors)) {
    if (isCacheMinutes(minutes)) document.collectors[id] = minutes
  }
  return document
}

export type CacheTimedSource = Pick<
  StorySource,
  "url" | "collector" | "cacheMinutes"
>

/**
 * How long this source's cached body stays fresh, in minutes. `0` is a real
 * answer meaning always refetch, so callers must not treat it as "unset".
 */
export function effectiveCacheMinutes(
  source: CacheTimedSource,
  timing: CacheTimingDocument,
  globalMinutes: number
): number {
  if (isCacheMinutes(source.cacheMinutes)) return source.cacheMinutes

  // A source naming a collector that does not exist here resolves to nothing
  // and therefore inherits the global default; it will fail to load for that
  // same reason, which is a source error rather than a timing question.
  const collector = source.collector
    ? get_parser_by_id(source.collector)
    : get_parser_for_url(source.url)
  if (collector) {
    const override = timing.collectors[collector.options.id]
    if (isCacheMinutes(override)) return override
    if (isCacheMinutes(collector.options.cache_minutes)) {
      return collector.options.cache_minutes
    }
  }

  return isCacheMinutes(globalMinutes) ? globalMinutes : DEFAULT_CACHE_MINUTES
}
