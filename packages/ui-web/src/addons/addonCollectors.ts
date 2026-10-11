import { StoryParser, registerCollector } from "@once/collectors"
import {
  AddonCollector,
  AddonManifest,
  Story,
  addonContributionId,
  grantedFetchPatterns,
  readAddonStories,
  validateConfig
} from "@once/core"
import type { AddonSandbox } from "./AddonSandbox"

/**
 * Wraps one of an add-on's collectors as a `StoryParser` the registry, the
 * loader, the cache, and the search box already know how to use. Fetching
 * and caching stay in Once; the body crosses into the sandbox and plain story
 * objects come back, vetted, with the collector's declared badge.
 */
export function registerAddonCollector(
  manifest: AddonManifest,
  collector: AddonCollector,
  sandbox: AddonSandbox
): () => void {
  const id = addonContributionId(manifest.id, collector.id)
  const toStories = (value: unknown): Story[] =>
    readAddonStories(value, collector.type).map((result) => Story.from_obj(result))
  const parser: StoryParser = {
    options: {
      id,
      type: collector.type,
      description: `${collector.description} (${manifest.name})`,
      pattern: [...collector.pattern],
      collects: collector.collects,
      colors: collector.colors,
      cache_minutes: collector.cacheMinutes,
      configSchema: collector.config
    },
    parse: () => {
      throw new Error(`${id} parses in its sandbox; the loader calls parseBody`)
    },
    parseBody: async (body, context) => {
      const session = await sandbox.ensure()
      return toStories(await session.collectorParse(collector.id, context.url, body, context.config))
    }
  }
  // The URL a script names is fetched only within its grants, and without
  // the source's credentials: the host is the add-on's choice, not the user's.
  const grants = grantedFetchPatterns(manifest)
  parser.fetchTarget = {
    resolve: async ({ url, config }) => {
      const session = await sandbox.ensure()
      const target = await session.resolve((requestId) => ({ type: "collector.resolveUrl", requestId, collector: collector.id, url, config }))
      if (target === null || target === undefined || target === url) return null
      if (typeof target !== "string" || !/^https?:\/\//i.test(target) || !grants.matches(target)) {
        throw new Error(`${manifest.name} named ${String(target)}, which no fetch: grant covers`)
      }
      return target
    },
    failed: async ({ url, fetchedUrl, error, config }) => {
      const session = await sandbox.ensure()
      return await session.resolve((requestId) => ({
        type: "collector.failed", requestId, collector: collector.id, url, fetchedUrl, error, config
      })) === true
    }
  }
  if (collector.config) {
    const schema = collector.config
    parser.normalizeConfig = (raw) => validateConfig(schema, raw)
    parser.serializeConfig = (config) => validateConfig(schema, config)
  }
  const search = (kind: "global" | "domain") => async (needle: string): Promise<Story[]> => {
    const session = await sandbox.ensure()
    return toStories(await session.collectorSearch(collector.id, kind, needle))
  }
  if (collector.search.includes("global")) parser.global_search = search("global")
  if (collector.search.includes("domain")) parser.domain_search = search("domain")
  return registerCollector(parser)
}
