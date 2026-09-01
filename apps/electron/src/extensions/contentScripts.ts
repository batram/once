// Which manifest content scripts apply to a frame, and the file cache that
// turns their paths into code. Matching is pure so tests drive it directly.

import { readFileSync } from "node:fs"
import { ContentScriptSpec, MatchPatternSet, WebExtensionManifest } from "@once/core"
import { LoadedExtension, resolveExtensionFile } from "./LoadedExtension"

export interface FrameIdentity {
  url: string
  /** The top document's URL; equals `url` for the main frame. */
  topUrl: string
  isTop: boolean
}

/** Isolated worlds start here; each loaded extension gets the next slot. */
export const CONTENT_WORLD_BASE = 1000

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

export function contentScriptsFor(
  manifest: WebExtensionManifest,
  frame: FrameIdentity
): ContentScriptSpec[] {
  const blank = frame.url === "about:blank" || frame.url === ""
  return manifest.contentScripts.filter((spec) => {
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
