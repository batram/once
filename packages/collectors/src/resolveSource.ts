/**
 * Turns a configured source into everything needed to load it: which collector
 * handles it, what URL to fetch, and its validated configuration.
 *
 * This is the single place a source's configuration is checked. Before, the
 * picker sanitized its own output, an imported line was never checked at all,
 * and the configurable collectors re-parsed their configuration out of a string
 * on every parse. Resolving once up front means `parse` can trust what it gets,
 * and means the URL to fetch is known before anything touches the cache — which
 * is what closed the old mismatch where the cache was read under the source line
 * but written under the resolved URL.
 */

import { StorySource, readLegacySourceLine } from "@once/core"
import { StoryParser, get_parser_by_id } from "./registry"
import { get_parser_for_url } from "./parser"

/**
 * Only the fields resolution needs. The generic preserves the complete source
 * (including its identity) when a stored StorySource is supplied, while the
 * legacy bridge can still use the smaller converted shape during the cutover.
 */
export type ResolvableSource = Pick<StorySource, "url" | "collector" | "select">

export interface ResolvedStorySource<
  TSource extends ResolvableSource = ResolvableSource
> {
  /** The source that was resolved; a stored source keeps its id and metadata. */
  source: TSource
  /** What gets fetched, and what the cache is keyed on. */
  url: string
  collector: StoryParser
  /** Validated collector configuration, if this collector takes one. */
  config?: unknown
}

/** Why a source cannot be loaded, in words fit for a source error. */
export interface UnresolvedStorySource {
  /**
   * Which kind of trouble, so the error surface can title it correctly. A
   * source nothing can collect is a different problem from one whose selectors
   * are wrong, and the advice differs too.
   */
  kind: "no-handler" | "configuration"
  problem: string
}

export type StorySourceResolution<
  TSource extends ResolvableSource = ResolvableSource
> = ResolvedStorySource<TSource> | UnresolvedStorySource

export function isResolved<TSource extends ResolvableSource>(
  resolution: StorySourceResolution<TSource>
): resolution is ResolvedStorySource<TSource> {
  return !("problem" in resolution)
}

export function resolveStorySource<TSource extends ResolvableSource>(
  source: TSource
): StorySourceResolution<TSource> {
  const collector = source.collector
    ? get_parser_by_id(source.collector)
    : get_parser_for_url(source.url)
  if (!collector) {
    return {
      kind: "no-handler",
      problem: source.collector
        ? `no collector with id "${source.collector}"`
        : "no handler available for this source type"
    }
  }

  if (!collector.normalizeConfig) {
    return { source, url: source.url, collector }
  }
  // A collector that takes configuration is asked to vet it here, so a bad
  // selector set is a source error rather than a parse-time surprise.
  try {
    return {
      source,
      url: source.url,
      collector,
      config: source.select === undefined
        ? undefined
        : collector.normalizeConfig(source.select)
    }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { kind: "configuration", problem: detail }
  }
}

/**
 * Resolves one line of the legacy format. This is the bridge that lets the app
 * keep loading what is already stored while sources are still lines; it goes
 * away once the stored format is objects.
 */
export function resolveLegacySourceLine(line: string): StorySourceResolution {
  const parsed = readLegacySourceLine(line)
  if ("problem" in parsed) return { kind: "configuration", ...parsed }
  return resolveStorySource(parsed)
}
