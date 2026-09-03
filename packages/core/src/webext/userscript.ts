// Userscript metadata blocks, the `// ==UserScript==` header Greasemonkey
// defined and Violentmonkey and Tampermonkey follow. Only the keys that
// decide where and when a script runs are typed; everything else stays in
// `raw` so a host can read `@grant` or `@connect` without a schema change.

import { MatchPatternError, parseMatchPattern, matchPatternMatches, MatchPattern } from "./matchPattern"

export type UserscriptRunAt = "document-start" | "document-end" | "document-idle"

export interface UserscriptMetadata {
  readonly name: string
  readonly namespace: string | null
  readonly version: string | null
  readonly description: string | null
  readonly matches: readonly string[]
  readonly includes: readonly string[]
  readonly excludes: readonly string[]
  readonly runAt: UserscriptRunAt
  readonly noFrames: boolean
  readonly grants: readonly string[]
  readonly requires: readonly string[]
  /** Every header key with all its values, in file order. */
  readonly raw: ReadonlyMap<string, readonly string[]>
}

export interface Userscript {
  readonly metadata: UserscriptMetadata
  /** The script with the header block removed. */
  readonly body: string
}

export class UserscriptError extends Error {
  constructor(reason: string) {
    super(`Invalid userscript: ${reason}`)
    this.name = "UserscriptError"
  }
}

const HEADER_START = /^\s*\/\/\s*==UserScript==\s*$/m
const HEADER_END = /^\s*\/\/\s*==\/UserScript==\s*$/m
const HEADER_LINE = /^\s*\/\/\s*@(\S+)(?:[ \t]+(.*?))?\s*$/

const RUN_AT: ReadonlySet<string> = new Set(["document-start", "document-end", "document-idle"])

export function parseUserscript(source: string): Userscript {
  const start = HEADER_START.exec(source)
  if (!start) throw new UserscriptError("missing ==UserScript== header")
  const end = HEADER_END.exec(source.slice(start.index + start[0].length))
  if (!end) throw new UserscriptError("missing ==/UserScript== footer")

  const headerStart = start.index + start[0].length
  const headerEnd = headerStart + end.index
  const raw = new Map<string, string[]>()
  for (const line of source.slice(headerStart, headerEnd).split(/\r?\n/)) {
    const match = HEADER_LINE.exec(line)
    if (!match) continue
    const key = match[1]
    const value = match[2] ?? ""
    const values = raw.get(key)
    if (values) values.push(value)
    else raw.set(key, [value])
  }

  const one = (key: string): string | null => raw.get(key)?.[0] ?? null
  const all = (key: string): string[] => raw.get(key)?.filter((v) => v.length > 0) ?? []

  const name = one("name")
  if (!name) throw new UserscriptError("@name is required")

  const runAt = one("run-at") ?? "document-end"
  if (!RUN_AT.has(runAt)) throw new UserscriptError(`unknown @run-at "${runAt}"`)

  const matches = all("match")
  for (const pattern of matches) {
    try {
      parseMatchPattern(pattern)
    } catch (error) {
      if (error instanceof MatchPatternError) throw new UserscriptError(error.message)
      throw error
    }
  }

  const body = source.slice(headerEnd + end[0].length).replace(/^\r?\n/, "")

  return {
    metadata: {
      name,
      namespace: one("namespace"),
      version: one("version"),
      description: one("description"),
      matches,
      includes: all("include"),
      excludes: all("exclude"),
      runAt: runAt as UserscriptRunAt,
      noFrames: raw.has("noframes"),
      grants: all("grant"),
      requires: all("require"),
      raw
    },
    body
  }
}

// `@include` and `@exclude` take globs where `*` matches anything, or a
// `/regex/` literal. The `.tld` magic suffix is not supported.
function globMatches(glob: string, url: string): boolean {
  if (glob.length > 2 && glob.startsWith("/") && glob.endsWith("/")) {
    try {
      return new RegExp(glob.slice(1, -1)).test(url)
    } catch {
      return false
    }
  }
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(url)
}

/** A userscript compiled for fast repeated matching against page URLs. */
export class UserscriptMatcher {
  private readonly matches: MatchPattern[]

  constructor(private readonly metadata: UserscriptMetadata) {
    this.matches = metadata.matches.map((source) => parseMatchPattern(source))
  }

  /**
   * Greasemonkey semantics: any `@exclude` wins; with no `@match` or `@include`
   * the script runs everywhere; otherwise any `@match` or `@include` must hit.
   */
  matchesUrl(url: URL): boolean {
    const href = url.href
    if (this.metadata.excludes.some((glob) => globMatches(glob, href))) return false
    if (this.matches.length === 0 && this.metadata.includes.length === 0) return true
    return (
      this.matches.some((pattern) => matchPatternMatches(pattern, url)) ||
      this.metadata.includes.some((glob) => globMatches(glob, href))
    )
  }
}
