/**
 * What the cache holds, and how it is cleared.
 *
 * Everything here keys on the URL a source resolves to, because that is what
 * the cache is keyed on. Two sources can share one URL, which is the whole
 * reason eviction asks who else still uses it before deleting anything.
 */

import { StorySource, StorySourceDocument } from "@once/core"
import { isResolved, resolveStorySource } from "@once/collectors"
import { AppSettings } from "./AppSettings"
import { CacheStorePort, SourceCacheStatus } from "./types"

/**
 * The cache-facing half of the client API. It owns nothing the loader needs,
 * so it stays out of the reload path: these are the settings-side questions
 * (what is cached, drop it all, drop what a deleted source left behind).
 */
export class CacheMaintenance {
  constructor(
    private readonly settings: AppSettings,
    private readonly cache: CacheStorePort | undefined,
    private readonly changed: () => void
  ) {}

  async status(): Promise<SourceCacheStatus[]> {
    const [document, cacheWindow] = await Promise.all([
      this.settings.getStorySources(),
      this.settings.cacheWindows()
    ])
    return sourceCacheStatus(document, cacheWindow, this.cache)
  }

  async clear(): Promise<void> {
    await this.cache?.clear()
    this.changed()
  }

  async evictRemoved(
    previous: StorySourceDocument,
    current: StorySourceDocument
  ): Promise<void> {
    const evicted = await evictRemovedSources(previous, current, this.cache)
    if (evicted.length) this.changed()
  }
}

/** The URL a source's body is cached under, or none if it cannot resolve. */
export function cacheKeyFor(source: StorySource): string | undefined {
  const resolved = resolveStorySource(source)
  return isResolved(resolved) ? resolved.url : undefined
}

function nameFor(source: StorySource): string {
  if (source.label?.trim()) return source.label.trim()
  try {
    return new URL(source.url).hostname.replace("www.", "")
  } catch {
    return source.url
  }
}

/**
 * When each source last fetched, beside the window it is judged against. The
 * timestamp comes out of the cached payload, which already carries it; a
 * sidecar index would be a second thing to keep true for a settings row that
 * is read far less often than it is written.
 */
export async function sourceCacheStatus(
  document: StorySourceDocument,
  cacheWindow: (source: StorySource) => number,
  cache?: CacheStorePort
): Promise<SourceCacheStatus[]> {
  return Promise.all(document.sources.map(async (source) => {
    const url = cacheKeyFor(source) ?? source.url
    const status: SourceCacheStatus = {
      sourceId: source.id,
      name: nameFor(source),
      url,
      collectorId: source.collector,
      cacheMinutes: cacheWindow(source),
      ownWindow: source.cacheMinutes !== undefined
    }
    const fetchedAt = await fetchedAtFor(url, cache)
    if (fetchedAt !== undefined) status.fetchedAt = fetchedAt
    return status
  }))
}

async function fetchedAtFor(
  url: string,
  cache?: CacheStorePort
): Promise<number | undefined> {
  if (!cache) return undefined
  try {
    const cached = await cache.get(url)
    if (!Array.isArray(cached) || typeof cached[0] !== "number") return undefined
    return cached[0]
  } catch {
    // A cache that cannot be read is a cache with nothing to report, not a
    // reason to fail the settings row it was being read for.
    return undefined
  }
}

/**
 * Drops the bodies of sources that are gone. A URL another remaining source
 * still fetches is kept: the entry is shared, and deleting it would make that
 * source refetch for no reason.
 */
export async function evictRemovedSources(
  previous: StorySourceDocument,
  current: StorySourceDocument,
  cache?: CacheStorePort
): Promise<string[]> {
  if (!cache) return []
  const kept = new Set(
    current.sources.map((source) => cacheKeyFor(source)).filter(Boolean)
  )
  const removed = new Set<string>()
  const surviving = new Set(current.sources.map((source) => source.id))
  for (const source of previous.sources) {
    if (surviving.has(source.id)) continue
    const url = cacheKeyFor(source)
    if (url && !kept.has(url)) removed.add(url)
  }
  for (const url of removed) await cache.delete(url)
  return [...removed]
}
