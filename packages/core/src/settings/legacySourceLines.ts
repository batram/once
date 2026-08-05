/**
 * Reads the line-based story-source format this app used to store, and converts
 * it to typed sources.
 *
 * This is the only place that still understands `§§`. Keeping it here rather
 * than in the collectors means the collectors can drop the hack entirely while
 * the conversion path stays able to read what was already saved.
 *
 * Derived ids are the point of the file. Two devices converting the same list
 * must arrive at the same ids, or they would sync as unrelated sources; so the
 * id comes from a hash of the line rather than from a random generator. The hash
 * only has to converge, not resist attack, which is why FNV-1a is enough — a
 * cryptographic digest in this package would force either an async API or a
 * Node-only dependency.
 */

import {
  IdSource,
  StorySource,
  StorySourceDocument,
  StorySourceGroup,
  StorySourceReport,
  SOURCES_SCHEMA_VERSION,
  mintStorySourceGroupId,
  mintStorySourceId
} from "./storySource"

export const LEGACY_SEPARATOR = "§§"
export const LEGACY_SOURCES_DOC_ID = "story_sources"

/**
 * Collector ids the two configurable legacy forms convert to. These are frozen
 * public identifiers: they land in stored sources, so the collector registry
 * must keep declaring exactly these strings, and a test there asserts it.
 */
const LEGACY_COLLECTORS: Record<string, string> = {
  "geny:": "geny",
  "json:": "jsonselect"
}

/**
 * The encoding every derived value is computed over.
 *
 * Each line is trimmed at both ends and blank lines are dropped, matching what
 * the live parsers already do, so a digest agrees with how a line is actually
 * interpreted. Newlines are normalized first, so the same list saved on Windows
 * and on Linux hashes identically.
 */
export function canonicalLegacySourceLines(lines: readonly string[]): string[] {
  return lines
    .join("\n")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
}

/** Identifies the exact legacy list a conversion was made from. */
export function legacySourceDigest(lines: readonly string[]): string {
  return hash(canonicalLegacySourceLines(lines).join("\n"))
}

export interface LegacyConversion {
  doc: StorySourceDocument
  reports: StorySourceReport[]
}

export interface LegacyConversionOptions {
  /** Only used for entries whose derived id collides. */
  mintId?: IdSource
  docId?: string
}

/**
 * Converts a legacy line list. Blank lines and group headers are structural, so
 * they pass silently; a malformed configurable source is reported rather than
 * dropped quietly, because it is the one case where a conversion loses something
 * the user meant to keep.
 */
export function convertLegacySourceLines(
  lines: readonly string[],
  options: LegacyConversionOptions = {}
): LegacyConversion {
  const canonical = canonicalLegacySourceLines(lines)
  const reports: StorySourceReport[] = []
  const groups: StorySourceGroup[] = []
  const sources: StorySource[] = []
  const usedIds = new Set<string>()
  const seen = new Map<string, number>()
  let groupId: string | undefined

  canonical.forEach((line, index) => {
    const occurrence = seen.get(line) ?? 0
    seen.set(line, occurrence + 1)

    if (line.startsWith("*")) {
      const name = line.slice(1)
      const id = derivedId("grp", line, occurrence, usedIds, options.mintId)
      groups.push({ id, name })
      groupId = id
      return
    }

    const parsed = readLegacySourceLine(line)
    if ("problem" in parsed) {
      reports.push({ path: `line ${index + 1}`, message: `${parsed.problem}: ${line}` })
      return
    }
    const source: StorySource = {
      id: derivedId("src", line, occurrence, usedIds, options.mintId),
      url: parsed.url
    }
    if (groupId) source.groupId = groupId
    if (parsed.collector) source.collector = parsed.collector
    if (parsed.select !== undefined) source.select = parsed.select
    sources.push(source)
  })

  return {
    doc: {
      version: SOURCES_SCHEMA_VERSION,
      migratedFrom: {
        docId: options.docId ?? LEGACY_SOURCES_DOC_ID,
        digest: legacySourceDigest(lines)
      },
      groups,
      sources
    },
    reports
  }
}

interface LegacySourceLine {
  url: string
  collector?: string
  select?: unknown
}

/**
 * Splits a source line. The two configurable forms are
 * `<prefix>§§<config>§§<url>`; everything else is a plain URL whose collector is
 * detected later from the URL itself.
 *
 * The URL is taken as everything after the second separator rather than by
 * splitting into three, so a separator inside the URL cannot truncate it. The
 * legacy builder refused to emit one, but a hand-written line was never checked.
 */
export function readLegacySourceLine(
  line: string
): LegacySourceLine | { problem: string } {
  const prefix = Object.keys(LEGACY_COLLECTORS).find((candidate) =>
    line.startsWith(candidate)
  )
  if (!prefix) return { url: line }

  const first = line.indexOf(LEGACY_SEPARATOR)
  const second = line.indexOf(LEGACY_SEPARATOR, first + LEGACY_SEPARATOR.length)
  if (first === -1 || second === -1) return { problem: "no selector configuration" }
  if (line.slice(0, first) !== prefix) return { problem: "malformed prefix" }

  const url = line.slice(second + LEGACY_SEPARATOR.length).trim()
  if (!url) return { problem: "no URL" }

  let select: unknown
  try {
    select = JSON.parse(line.slice(first + LEGACY_SEPARATOR.length, second))
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    return { problem: `unreadable selector configuration (${detail})` }
  }
  return { url, collector: LEGACY_COLLECTORS[prefix], select }
}

/**
 * `<kind>_<hash of the line and how many identical lines came before it>`.
 *
 * Counting identical lines rather than absolute position is what keeps ids
 * steady when an unrelated line is added or removed, which matters because two
 * devices may convert lists that differ slightly. A collision falls back to
 * rehashing with a counter, so the result stays reproducible.
 */
function derivedId(
  kind: "src" | "grp",
  line: string,
  occurrence: number,
  usedIds: Set<string>,
  mintId?: IdSource
): string {
  const key = `${line}\n${occurrence}`
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const suffix = hash(attempt === 0 ? key : `${key}#${attempt}`)
    const id = `${kind}_${suffix}`
    if (!usedIds.has(id)) {
      usedIds.add(id)
      return id
    }
  }
  // Eight collisions on a 32-bit hash is not something to keep retrying; a
  // minted id costs only cross-device convergence for this one entry.
  const id = kind === "src"
    ? mintStorySourceId(mintId)
    : mintStorySourceGroupId(mintId)
  usedIds.add(id)
  return id
}

/** FNV-1a, as eight hex characters so every id meets the length grammar. */
function hash(text: string): string {
  let value = 0x811c9dc5
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index)
    value = Math.imul(value, 0x01000193) >>> 0
  }
  return value.toString(16).padStart(8, "0")
}
