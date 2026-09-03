// The two settings docs behind extensions and userscripts: which
// filter lists to subscribe to, and which userscripts to run. They are
// stored and synced like every other Once setting, and each target hands
// them to whatever runs there (uBlock and Violentmonkey on Electron and
// Android, content rules and user scripts on iOS). The text forms are what
// the settings editors show.

import { parseUserscript, UserscriptError } from "../webext/userscript"

export const FILTER_LISTS_DOCUMENT_ID = "filter_lists"
export const FILTER_LISTS_VERSION = 1

export interface FilterListSubscription {
  url: string
  enabled: boolean
}

export interface FilterListsDocument {
  version: number
  lists: FilterListSubscription[]
}

export const USERSCRIPTS_DOCUMENT_ID = "userscripts"
export const USERSCRIPTS_VERSION = 1

export interface UserscriptEntry {
  /** Stable across edits: derived from the script's namespace and name. */
  id: string
  name: string
  source: string
  enabled: boolean
}

export interface UserscriptsDocument {
  version: number
  scripts: UserscriptEntry[]
}

export function emptyFilterListsDocument(): FilterListsDocument {
  return { version: FILTER_LISTS_VERSION, lists: [] }
}

export function emptyUserscriptsDocument(): UserscriptsDocument {
  return { version: USERSCRIPTS_VERSION, scripts: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function isFilterListUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === "https:" || url.protocol === "http:"
  } catch {
    return false
  }
}

/** Tolerant read of another client's doc; anything unusable is dropped. */
export function readFilterListsDocument(value: unknown): FilterListsDocument {
  const doc = emptyFilterListsDocument()
  if (!isRecord(value) || value.version !== FILTER_LISTS_VERSION) return doc
  if (!Array.isArray(value.lists)) return doc
  const seen = new Set<string>()
  for (const entry of value.lists) {
    if (!isRecord(entry) || typeof entry.url !== "string") continue
    const url = entry.url.trim()
    if (!isFilterListUrl(url) || seen.has(url)) continue
    seen.add(url)
    doc.lists.push({ url, enabled: entry.enabled !== false })
  }
  return doc
}

/** A short, stable id from the header the way Greasemonkey identifies scripts. */
export function userscriptId(namespace: string | null, name: string): string {
  const key = `${namespace ?? ""}\n${name}`
  let hash = 5381
  for (let index = 0; index < key.length; index += 1) {
    hash = ((hash << 5) + hash + key.charCodeAt(index)) | 0
  }
  return `usc_${(hash >>> 0).toString(36).padStart(7, "0")}`
}

export function readUserscriptsDocument(value: unknown): UserscriptsDocument {
  const doc = emptyUserscriptsDocument()
  if (!isRecord(value) || value.version !== USERSCRIPTS_VERSION) return doc
  if (!Array.isArray(value.scripts)) return doc
  const seen = new Set<string>()
  for (const entry of value.scripts) {
    if (!isRecord(entry) || typeof entry.source !== "string") continue
    let parsed
    try {
      parsed = parseUserscript(entry.source)
    } catch {
      continue
    }
    const id = userscriptId(parsed.metadata.namespace, parsed.metadata.name)
    if (seen.has(id)) continue
    seen.add(id)
    doc.scripts.push({
      id,
      name: parsed.metadata.name,
      source: entry.source,
      enabled: entry.enabled !== false
    })
  }
  return doc
}

// Text form: one list URL per line. A line starting with `#` keeps the list
// but disabled, so a user can switch one off without losing it. Anything
// else that is not a URL is an error the editor shows.

export function presentFilterLists(doc: FilterListsDocument): string {
  return doc.lists
    .map((list) => (list.enabled ? list.url : `# ${list.url}`))
    .join("\n")
}

export function parseFilterListsText(text: string): FilterListsDocument {
  const doc = emptyFilterListsDocument()
  const invalid: string[] = []
  const seen = new Set<string>()
  for (const raw of text.split("\n")) {
    const line = raw.trim()
    if (line === "") continue
    const enabled = !line.startsWith("#")
    const url = enabled ? line : line.replace(/^#+\s*/, "")
    if (!isFilterListUrl(url)) {
      invalid.push(raw)
      continue
    }
    if (seen.has(url)) continue
    seen.add(url)
    doc.lists.push({ url, enabled })
  }
  if (invalid.length > 0) {
    throw new Error(`Not a filter list URL: ${invalid.join(", ")}`)
  }
  return doc
}

// Text form: the scripts themselves, one after another; each starts at its
// `// ==UserScript==` line. A `// @once-disabled` line inside a header keeps
// the script but switches it off.

const HEADER_START = /^[ \t]*\/\/[ \t]*==UserScript==[ \t]*$/m
const DISABLED_KEY = "once-disabled"

export function presentUserscripts(doc: UserscriptsDocument): string {
  return doc.scripts
    .map((script) => (script.enabled ? script.source : withDisabledMarker(script.source)))
    .map((source) => source.trimEnd())
    .join("\n\n")
}

function withDisabledMarker(source: string): string {
  if (parseUserscript(source).metadata.raw.has(DISABLED_KEY)) return source
  const start = HEADER_START.exec(source)
  if (!start) return source
  const insertAt = start.index + start[0].length
  return `${source.slice(0, insertAt)}\n// @${DISABLED_KEY}${source.slice(insertAt)}`
}

export function parseUserscriptsText(text: string): UserscriptsDocument {
  const doc = emptyUserscriptsDocument()
  if (text.trim() === "") return doc
  const starts: number[] = []
  const pattern = new RegExp(HEADER_START.source, "gm")
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    starts.push(match.index)
  }
  if (starts.length === 0 || text.slice(0, starts[0]).trim() !== "") {
    throw new Error("Each userscript must start with a // ==UserScript== header")
  }
  const seen = new Set<string>()
  starts.forEach((start, index) => {
    const source = text.slice(start, starts[index + 1] ?? text.length).trimEnd()
    let parsed
    try {
      parsed = parseUserscript(source)
    } catch (error) {
      const detail = error instanceof UserscriptError ? error.message : String(error)
      throw new Error(`Userscript ${index + 1}: ${detail}`)
    }
    const id = userscriptId(parsed.metadata.namespace, parsed.metadata.name)
    if (seen.has(id)) {
      throw new Error(`Userscript "${parsed.metadata.name}" appears twice`)
    }
    seen.add(id)
    doc.scripts.push({
      id,
      name: parsed.metadata.name,
      source,
      enabled: !parsed.metadata.raw.has(DISABLED_KEY)
    })
  })
  return doc
}
