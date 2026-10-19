// Which content scripts apply to a frame, and the file cache that turns
// their paths into code. Matching is pure so tests drive it directly.

import { ContentScriptRunAt, ContentScriptSpec, MatchPatternSet, isMatchPattern } from "@once/core"
import { LoadedExtension, readExtensionText } from "./LoadedExtension"
import { extensionUrl } from "./ExtensionScheme"
import { ContentScriptBatch, RegisterContentScriptOptions } from "./protocol"

export interface FrameIdentity {
  url: string
  /** The top document's URL; equals `url` for the main frame. */
  topUrl: string
  isTop: boolean
}

/**
 * A content script from the manifest or from `contentScripts.register`.
 * File entries are extension paths; inline entries are code as given.
 */
export interface ContentScript {
  readonly spec: ContentScriptSpec
  readonly inlineJs: readonly string[]
  readonly inlineCss: readonly string[]
}

/** Isolated worlds start here; each loaded extension gets the next slot. */
export const CONTENT_WORLD_BASE = 1000

const RUN_AT: ReadonlySet<string> = new Set(["document_start", "document_end", "document_idle"])

const compiled = new WeakMap<ContentScriptSpec, { matches: MatchPatternSet; excludes: MatchPatternSet }>()

function patterns(spec: ContentScriptSpec): { matches: MatchPatternSet; excludes: MatchPatternSet } {
  let sets = compiled.get(spec)
  if (!sets) {
    sets = {
      matches: new MatchPatternSet(spec.matches),
      excludes: new MatchPatternSet(spec.excludeMatches)
    }
    compiled.set(spec, sets)
  }
  return sets
}

export function manifestContentScripts(specs: readonly ContentScriptSpec[]): ContentScript[] {
  return specs.map((spec) => ({ spec, inlineJs: [], inlineCss: [] }))
}

/** Validates a `contentScripts.register` request the way Firefox would. */
export function registeredContentScript(options: unknown): ContentScript {
  const record = (typeof options === "object" && options !== null ? options : {}) as
    Partial<RegisterContentScriptOptions>
  const matches = Array.isArray(record.matches) ? record.matches : []
  if (matches.length === 0 || !matches.every((entry) => typeof entry === "string" && isMatchPattern(entry))) {
    throw new Error("contentScripts.register needs valid match patterns")
  }
  const excludeMatches = Array.isArray(record.excludeMatches) ? record.excludeMatches : []
  const runAt = record.runAt ?? "document_idle"
  if (!RUN_AT.has(runAt)) throw new Error("contentScripts.register: unknown runAt")
  const split = (entries: { file?: string; code?: string }[] | undefined) => {
    const files: string[] = []
    const inline: string[] = []
    for (const entry of entries ?? []) {
      if (typeof entry?.file === "string") files.push(entry.file)
      else if (typeof entry?.code === "string") inline.push(entry.code)
    }
    return { files, inline }
  }
  const js = split(record.js)
  const css = split(record.css)
  if (js.files.length + js.inline.length + css.files.length + css.inline.length === 0) {
    throw new Error("contentScripts.register needs js or css")
  }
  return {
    spec: {
      ...(record.world === "MAIN" ? { world: "MAIN" as const } : {}),
      matches,
      excludeMatches,
      js: js.files,
      css: css.files,
      runAt: runAt as ContentScriptRunAt,
      allFrames: record.allFrames === true,
      matchAboutBlank: record.matchAboutBlank === true
    },
    inlineJs: js.inline,
    inlineCss: css.inline
  }
}

export function contentScriptsFor(
  scripts: readonly ContentScript[],
  frame: FrameIdentity
): ContentScript[] {
  const blank = frame.url === "about:blank" || frame.url === ""
  return scripts.filter(({ spec }) => {
    if (!frame.isTop && !spec.allFrames) return false
    let subject = frame.url
    if (blank) {
      if (!spec.matchAboutBlank) return false
      subject = frame.topUrl
    }
    const { matches, excludes } = patterns(spec)
    return matches.matches(subject) && !excludes.matches(subject)
  })
}

/**
 * Reads extension files once. Content-script sources are needed
 * synchronously when a frame asks, so this is a synchronous cache.
 */
export class ExtensionFiles {
  private readonly cache = new Map<string, string>()

  constructor(private readonly extension: LoadedExtension) {}

  read(relativePath: string): string {
    const cached = this.cache.get(relativePath)
    if (cached !== undefined) return cached
    const code = readExtensionText(this.extension, relativePath)
    if (code === null) {
      throw new Error(`${relativePath} is outside the extension or missing from ${this.extension.name}`)
    }
    this.cache.set(relativePath, code)
    return code
  }
}

/** Content scripts grouped by phase and world, in registration order, as code. */
export function contentScriptBatches(
  host: { extension: LoadedExtension; files: ExtensionFiles },
  scripts: readonly ContentScript[]
): ContentScriptBatch[] {
  const byPhase = new Map<string, ContentScriptBatch>()
  for (const { spec, inlineJs, inlineCss } of scripts) {
    const key = `${spec.runAt}:${spec.world ?? "ISOLATED"}`
    let batch = byPhase.get(key)
    if (!batch) {
      batch = { runAt: spec.runAt, world: spec.world, js: [], css: [] }
      byPhase.set(key, batch)
    }
    for (const file of spec.css) batch.css.push(host.files.read(file))
    batch.css.push(...inlineCss)
    for (const file of spec.js) {
      batch.js.push({ url: extensionUrl(host.extension.host, file), code: host.files.read(file) })
    }
    for (const code of inlineJs) {
      batch.js.push({ url: extensionUrl(host.extension.host, "_registered_content_script.js"), code })
    }
  }
  return [...byPhase.values()]
}
