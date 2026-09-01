// Which content scripts apply to a frame, and the file cache that turns
// their paths into code. Matching is pure so tests drive it directly.

import { readFileSync } from "node:fs"
import { ContentScriptRunAt, ContentScriptSpec, MatchPatternSet, isMatchPattern } from "@once/core"
import { LoadedExtension, resolveExtensionFile } from "./LoadedExtension"
import { RegisterContentScriptOptions } from "./protocol"

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
    const file = resolveExtensionFile(this.extension, relativePath)
    if (!file) throw new Error(`${relativePath} is outside the extension`)
    const code = readFileSync(file, "utf8")
    this.cache.set(relativePath, code)
    return code
  }
}
