/**
 * Typed story sources.
 *
 * A source used to be one opaque line of text, which meant it had no identity:
 * the line itself was the key for its errors, its loader issues and its
 * highlight, so editing a URL silently broke all of them. Here a source is an
 * object with an id that is minted once and never re-derived, so every
 * association survives an edit.
 *
 * Identity rules, which the rest of the app depends on:
 * - `id` is opaque. Nothing computes it from the content, so inserting a
 *   duplicate or reordering rows cannot shift anybody's id.
 * - ids are prefixed and padded, so persisted and freshly minted ids share one
 *   grammar.
 * - the Default group is implicit: a source with no `groupId` is in it. No
 *   Default entry is ever stored in `groups`.
 *
 * Reading is deliberately two-mode. `parseStorySources` is strict, for text the
 * user authored: it rejects rather than guessing, so a typo cannot quietly
 * delete a source. `repairStorySources` is tolerant, for a stored record that
 * another (possibly older) client wrote: it repairs what it can and reports
 * every repair. One permissive reader serving both would risk data loss.
 */

export const SOURCES_SCHEMA_VERSION = 2

/**
 * The implicit Default group. Reserved: it must never appear in `groups`, and
 * only the editor uses it, to label the row holding sources with no `groupId`.
 */
export const DEFAULT_GROUP_ID = "group_default"
export const DEFAULT_GROUP_NAME = "Default"

/** One year. Longer is indistinguishable from "never" and reads as a typo. */
export const MAX_CACHE_MINUTES = 525_600

/**
 * What a source falls back to when neither it, the user, nor its collector has
 * an opinion. An hour: long enough that reopening the app all day costs almost
 * nothing, short enough that a feed nobody has taught the app about is not a
 * day stale. Every shell reads it from here so the four stores cannot drift.
 */
export const DEFAULT_CACHE_MINUTES = 60

const ID_SUFFIX = "[A-Za-z0-9]{8,58}"
const SOURCE_ID = new RegExp(`^src_${ID_SUFFIX}$`)
const GROUP_ID = new RegExp(`^grp_${ID_SUFFIX}$`)

export interface StorySourceGroup {
  id: string
  name: string
}

/**
 * How a source's requests identify the user. Only the shape is stored with the
 * source, which syncs between devices in the clear; a token itself lives in the
 * device's secret store under the source id, and never in this record.
 *
 * - `session` sends whatever cookies the shell holds for the host, so a site
 *   the user is logged into in the browser answers as that user.
 * - `token` sends the stored secret verbatim in a request header, which is
 *   `Authorization` unless the source names another.
 */
export type StorySourceAuth =
  | { kind: "session" }
  | { kind: "token"; header?: string }

export const DEFAULT_AUTH_HEADER = "Authorization"

/** An HTTP header name: RFC 7230 tokens, which is what a fetch accepts. */
const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/

/** The stored shape, or null when the value cannot be one. */
export function readStorySourceAuth(value: unknown): StorySourceAuth | null {
  if (!value || typeof value !== "object") return null
  const input = value as Partial<{ kind: unknown; header: unknown }>
  if (input.kind === "session") return { kind: "session" }
  if (input.kind !== "token") return null
  if (input.header === undefined) return { kind: "token" }
  if (typeof input.header !== "string" || !HEADER_NAME.test(input.header)) return null
  return { kind: "token", header: input.header }
}

export interface StorySource {
  /** Opaque and permanent. See the identity rules above. */
  id: string
  /** What gets fetched, and what the cache is keyed on. */
  url: string
  /** Absent means the implicit Default group. */
  groupId?: string
  /** Explicit collector id; absent means detect it from `url`. */
  collector?: string
  /** Display name; absent means derive one from the host. */
  label?: string
  /** Absent means true. A disabled source is never fetched. */
  enabled?: boolean
  /** Absent means inherit the collector, then the global default. */
  cacheMinutes?: number
  /** Fetch and store each new story's article for the reader. Absent means no. */
  saveContent?: boolean
  /** Collector configuration. Validated at the collector boundary, not here. */
  select?: unknown
  /** How requests identify the user. Absent means anonymously. */
  auth?: StorySourceAuth
}

export interface StorySourceDocument {
  version: number
  /** Historical provenance retained by documents created during the cutover. */
  migratedFrom?: {
    /** list-store id the sources were converted from. */
    docId: string
    digest: string
  }
  groups: StorySourceGroup[]
  sources: StorySource[]
}

/** What was wrong, and what was done about it. */
export interface StorySourceReport {
  /** Where the trouble was, e.g. `sources[3].cacheMinutes`. */
  path: string
  message: string
}

export type StorySourceRead =
  | { ok: true; doc: StorySourceDocument; reports: StorySourceReport[] }
  | { ok: false; reports: StorySourceReport[] }

/** Returns an id suffix. Injected so tests do not depend on randomness. */
export type IdSource = () => string

export interface StorySourceReadOptions {
  mintId?: IdSource
}

export function emptyStorySourceDocument(): StorySourceDocument {
  return { version: SOURCES_SCHEMA_VERSION, groups: [], sources: [] }
}

export function isStorySourceId(value: unknown): value is string {
  return typeof value === "string" && SOURCE_ID.test(value)
}

export function isStorySourceGroupId(value: unknown): value is string {
  return typeof value === "string" && GROUP_ID.test(value)
}

function defaultMintId(): string {
  // Available in every shell this runs in, and in Node. Dashes are stripped so
  // the value matches the id grammar.
  return crypto.randomUUID().replaceAll("-", "")
}

export function mintStorySourceId(mintId: IdSource = defaultMintId): string {
  return `src_${mintId()}`
}

export function mintStorySourceGroupId(mintId: IdSource = defaultMintId): string {
  return `grp_${mintId()}`
}

/**
 * Absent stays absent, meaning inherit. `0` is kept: it means always refetch.
 * Anything outside the range is not a value we can honour, so it is refused
 * rather than clamped — a clamp would silently invent a policy.
 */
export function isCacheMinutes(value: unknown): value is number {
  return typeof value === "number" &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= MAX_CACHE_MINUTES
}

/**
 * What the user typed into a cache-minutes field. Blank means inherit, which is
 * why absence is a success rather than a fault. Anything that is not a plain
 * whole number is refused instead of coerced: `parseInt` would happily read
 * "5 minutes" as five and "1e3" as one, and a silently invented cache policy is
 * worse than a rejected edit.
 */
export type CacheMinutesInput =
  | { ok: true; minutes?: number }
  | { ok: false }

export function readCacheMinutesInput(text: string): CacheMinutesInput {
  const trimmed = text.trim()
  if (!trimmed) return { ok: true }
  if (!/^\d+$/.test(trimmed)) return { ok: false }
  const minutes = Number(trimmed)
  return isCacheMinutes(minutes) ? { ok: true, minutes } : { ok: false }
}

/** Sources that can actually produce stories. */
export function enabledStorySources(doc: StorySourceDocument): StorySource[] {
  return doc.sources.filter((source) => source.enabled !== false)
}

export interface StorySourceGroupView extends StorySourceGroup {
  sources: StorySource[]
}

/**
 * Groups in reading order with Default first, which is where the sources
 * carrying no `groupId` live. Default is always present even when empty, so the
 * editor always has somewhere to drag a source to.
 */
export function groupedStorySources(
  doc: StorySourceDocument
): StorySourceGroupView[] {
  const views = new Map<string, StorySourceGroupView>()
  views.set(DEFAULT_GROUP_ID, {
    id: DEFAULT_GROUP_ID,
    name: DEFAULT_GROUP_NAME,
    sources: []
  })
  for (const group of doc.groups) {
    views.set(group.id, { ...group, sources: [] })
  }
  for (const source of doc.sources) {
    const view = views.get(source.groupId ?? DEFAULT_GROUP_ID)
    // A reference this dangling cannot reach here: both readers repair it.
    if (view) view.sources.push(source)
  }
  return [...views.values()]
}

interface ReadContext {
  strict: boolean
  mintId: IdSource
  usedIds: Set<string>
  groupIds: Set<string>
  reports: StorySourceReport[]
}

function fault(context: ReadContext, path: string, message: string): void {
  context.reports.push({ path, message })
}

function readGroup(
  raw: unknown,
  index: number,
  context: ReadContext
): StorySourceGroup | null {
  const path = `groups[${index}]`
  if (!raw || typeof raw !== "object") {
    fault(context, path, "not an object")
    return null
  }
  const group = raw as Partial<StorySourceGroup>
  // Checked before the grammar, which the reserved name already fails, so the
  // more specific message is the one the caller sees.
  if (group.id === DEFAULT_GROUP_ID) {
    fault(context, `${path}.id`, "the Default group is implicit and must not be stored")
    return null
  }
  if (!isStorySourceGroupId(group.id)) {
    // Minting here would let a rewrite orphan every member, so a group without
    // a usable id is refused in both modes.
    fault(context, `${path}.id`, `not a group id: ${String(group.id)}`)
    return null
  }
  if (context.groupIds.has(group.id)) {
    fault(context, `${path}.id`, `duplicate group id: ${group.id}`)
    return null
  }
  if (typeof group.name !== "string") {
    fault(context, `${path}.name`, "missing")
    return null
  }
  context.groupIds.add(group.id)
  return { id: group.id, name: group.name }
}

function readSource(
  raw: unknown,
  index: number,
  context: ReadContext
): StorySource | null {
  const path = `sources[${index}]`
  if (!raw || typeof raw !== "object") {
    fault(context, path, "not an object")
    return null
  }
  const input = raw as Partial<StorySource>
  if (typeof input.url !== "string" || !input.url.trim()) {
    fault(context, `${path}.url`, "missing")
    return null
  }

  let id = input.id
  if (!isStorySourceId(id) || context.usedIds.has(id)) {
    const trouble = isStorySourceId(id) ? "duplicate" : "not a source id"
    if (context.strict) {
      fault(context, `${path}.id`, `${trouble}: ${String(input.id)}`)
      return null
    }
    id = uniqueId(context)
    fault(context, `${path}.id`, `${trouble}: ${String(input.id)}; minted ${id}`)
  }
  context.usedIds.add(id)

  const source: StorySource = { id, url: input.url.trim() }
  if (!readInto(source, input, path, context)) return null
  return source
}

/** The optional fields, which differ between the modes only in how they fail. */
function readInto(
  source: StorySource,
  input: Partial<StorySource>,
  path: string,
  context: ReadContext
): boolean {
  if (input.groupId !== undefined) {
    if (context.groupIds.has(input.groupId)) {
      source.groupId = input.groupId
    } else if (context.strict) {
      fault(context, `${path}.groupId`, `no such group: ${String(input.groupId)}`)
      return false
    } else {
      // Left absent, which is the Default group. Never dangling.
      fault(
        context,
        `${path}.groupId`,
        `no such group: ${String(input.groupId)}; moved to ${DEFAULT_GROUP_NAME}`
      )
    }
  }
  for (const [key, value] of [
    ["collector", input.collector],
    ["label", input.label]
  ] as const) {
    if (value === undefined) continue
    if (typeof value === "string" && value.trim()) source[key] = value.trim()
    else if (context.strict) {
      fault(context, `${path}.${key}`, "not a non-empty string")
      return false
    } else fault(context, `${path}.${key}`, "not a non-empty string; dropped")
  }
  for (const key of ["enabled", "saveContent"] as const) {
    const value = input[key]
    if (value === undefined) continue
    if (typeof value === "boolean") source[key] = value
    else if (context.strict) {
      fault(context, `${path}.${key}`, "not a boolean")
      return false
    } else fault(context, `${path}.${key}`, "not a boolean; dropped")
  }
  if (input.cacheMinutes !== undefined) {
    if (isCacheMinutes(input.cacheMinutes)) source.cacheMinutes = input.cacheMinutes
    else if (context.strict) {
      fault(
        context,
        `${path}.cacheMinutes`,
        `not a whole number of minutes from 0 to ${MAX_CACHE_MINUTES}`
      )
      return false
    } else fault(context, `${path}.cacheMinutes`, "out of range; inherits instead")
  }
  if (input.select !== undefined) source.select = input.select
  if (input.auth !== undefined) {
    const auth = readStorySourceAuth(input.auth)
    if (auth) source.auth = auth
    else if (context.strict) {
      fault(context, `${path}.auth`, "not a session or token authentication")
      return false
    } else fault(context, `${path}.auth`, "not a session or token authentication; dropped")
  }
  return true
}

function uniqueId(context: ReadContext): string {
  let id = mintStorySourceId(context.mintId)
  while (context.usedIds.has(id)) id = mintStorySourceId(context.mintId)
  return id
}

function readDoc(
  value: unknown,
  strict: boolean,
  options: StorySourceReadOptions
): StorySourceRead {
  const context: ReadContext = {
    strict,
    mintId: options.mintId ?? defaultMintId,
    usedIds: new Set(),
    groupIds: new Set(),
    reports: []
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fault(context, "", "not a story-sources record")
    return { ok: false, reports: context.reports }
  }
  const input = value as Partial<StorySourceDocument>
  // An unknown version is never repaired or downgraded: a newer client wrote
  // fields this build cannot see, and rewriting would drop them.
  if (input.version !== SOURCES_SCHEMA_VERSION) {
    fault(
      context,
      "version",
      `unsupported schema version ${String(input.version)}; expected ${SOURCES_SCHEMA_VERSION}`
    )
    return { ok: false, reports: context.reports }
  }

  const groups: StorySourceGroup[] = []
  const rawGroups = Array.isArray(input.groups) ? input.groups : []
  if (!Array.isArray(input.groups)) fault(context, "groups", "not an array")
  rawGroups.forEach((raw, index) => {
    const group = readGroup(raw, index, context)
    if (group) groups.push(group)
  })

  const sources: StorySource[] = []
  const rawSources = Array.isArray(input.sources) ? input.sources : []
  if (!Array.isArray(input.sources)) fault(context, "sources", "not an array")
  rawSources.forEach((raw, index) => {
    const source = readSource(raw, index, context)
    if (source) sources.push(source)
  })

  if (strict && context.reports.length > 0) {
    return { ok: false, reports: context.reports }
  }
  const doc: StorySourceDocument = {
    version: SOURCES_SCHEMA_VERSION,
    groups,
    sources
  }
  if (input.migratedFrom) {
    const { docId, digest } = input.migratedFrom
    if (typeof docId === "string" && typeof digest === "string") {
      doc.migratedFrom = { docId, digest }
    } else fault(context, "migratedFrom", "incomplete; dropped")
  }
  return { ok: true, doc, reports: context.reports }
}

/**
 * Strict read, for text the user authored. Any fault rejects the whole thing so
 * the caller can leave what is already stored untouched.
 */
export function parseStorySources(
  value: unknown,
  options: StorySourceReadOptions = {}
): StorySourceRead {
  return readDoc(value, true, options)
}

/**
 * Tolerant read, for a stored record written by another client. Repairs what it
 * can, refuses only what it cannot represent, and reports every repair so a
 * caller can surface them instead of losing them.
 */
export function repairStorySources(
  value: unknown,
  options: StorySourceReadOptions = {}
): StorySourceRead {
  return readDoc(value, false, options)
}

export interface StorySourceReconciliation {
  sources: StorySource[]
  reports: StorySourceReport[]
}

/**
 * Matches imported sources against what is already stored so an import keeps
 * ids and settings instead of resetting them.
 *
 * A supplied id wins. Otherwise an entry is paired with the next unclaimed
 * stored source having the same url and collector, and inherits its id plus any
 * field the import left out — which is how pasting a bare list of URLs keeps
 * every per-source setting. Pairing duplicates is positional and therefore a
 * guess, so it is reported rather than done quietly. Unmatched entries are new.
 *
 * Note that an omitted field means "inherit", never "clear": a plain URL list
 * cannot express clearing, so clearing is the editor's job.
 */
export function reconcileStorySources(
  incoming: StorySource[],
  existing: readonly StorySource[],
  options: StorySourceReadOptions = {}
): StorySourceReconciliation {
  const mintId = options.mintId ?? defaultMintId
  const byId = new Map(existing.map((source) => [source.id, source]))
  const byShape = new Map<string, StorySource[]>()
  for (const source of existing) {
    const key = shapeKey(source)
    const queue = byShape.get(key)
    if (queue) queue.push(source)
    else byShape.set(key, [source])
  }

  const reports: StorySourceReport[] = []
  const claimed = new Set<string>()
  const used = new Set<string>()
  const sources = incoming.map((source, index) => {
    const path = `sources[${index}]`
    let matched = isStorySourceId(source.id) ? byId.get(source.id) : undefined
    if (matched && claimed.has(matched.id)) matched = undefined
    if (!matched) {
      const queue = byShape.get(shapeKey(source)) ?? []
      const available = queue.filter((candidate) => !claimed.has(candidate.id))
      matched = available[0]
      if (matched && available.length > 1) {
        reports.push({
          path,
          message: `${source.url} appears more than once; paired with ${matched.id} by position`
        })
      }
    }
    const merged = matched ? inherit(source, matched) : { ...source }
    if (matched) claimed.add(matched.id)
    if (!isStorySourceId(merged.id) || used.has(merged.id)) {
      merged.id = mintStorySourceId(mintId)
      while (used.has(merged.id)) merged.id = mintStorySourceId(mintId)
    }
    used.add(merged.id)
    return merged
  })
  return { sources, reports }
}

function shapeKey(source: StorySource): string {
  return `${source.url}\0${source.collector ?? ""}`
}

/**
 * Spelled out per field rather than looped: the types differ, and a loop would
 * need a cast that gives up the checking this is here to get. Both sides are
 * guarded so an inherited-from-nothing field stays genuinely absent rather than
 * becoming an own property holding undefined, which deep equality would notice.
 */
function inherit(incoming: StorySource, matched: StorySource): StorySource {
  const merged: StorySource = { ...incoming, id: matched.id }
  if (merged.groupId === undefined && matched.groupId !== undefined) {
    merged.groupId = matched.groupId
  }
  if (merged.collector === undefined && matched.collector !== undefined) {
    merged.collector = matched.collector
  }
  if (merged.label === undefined && matched.label !== undefined) {
    merged.label = matched.label
  }
  if (merged.enabled === undefined && matched.enabled !== undefined) {
    merged.enabled = matched.enabled
  }
  if (merged.cacheMinutes === undefined && matched.cacheMinutes !== undefined) {
    merged.cacheMinutes = matched.cacheMinutes
  }
  if (merged.saveContent === undefined && matched.saveContent !== undefined) {
    merged.saveContent = matched.saveContent
  }
  if (merged.select === undefined && matched.select !== undefined) {
    merged.select = matched.select
  }
  if (merged.auth === undefined && matched.auth !== undefined) {
    merged.auth = matched.auth
  }
  return merged
}
