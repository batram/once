// Which side of the seam a userscript change came from. Once's document and
// Violentmonkey's own dashboard are both editors of the same scripts, and
// Once used to win every round: an edit made in the dashboard was replaced by
// Once's copy at the next hand-off, and a script installed there stayed
// invisible to Once and to every other device. This plans a reconciliation
// instead — Once writes what the document changed, and adopts what the
// dashboard changed into the document, so both surfaces stay true.

import {
  parseUserscript,
  UserscriptEntry,
  userscriptId,
  UserscriptsDocument,
  USERSCRIPTS_VERSION
} from "@once/core"

/** One script as Violentmonkey currently holds it. */
export interface InstalledUserscript {
  /** Violentmonkey's own numeric id. */
  id: number
  namespace: string | null
  name: string
  code: string
  enabled: boolean
}

/**
 * What the last hand-off left behind, keyed by Once's id. `source` is the
 * document's text and `code` what Violentmonkey held straight afterwards:
 * comparing each against today's value says which side moved, and the two are
 * not interchangeable because an install may normalise the text it stores.
 */
export interface AppliedUserscript {
  id: number
  source?: string
  code?: string
  enabled?: boolean
}

export interface UserscriptPlan {
  /** The document as it should now read, with adopted changes folded in. */
  document: UserscriptsDocument
  /** Whether that differs from the document handed in. */
  adopted: boolean
  /** Scripts to write into Violentmonkey, in document order. */
  install: UserscriptEntry[]
  /** Switches to flip on scripts that are staying as they are. */
  toggle: { id: number; enabled: boolean }[]
  /** Violentmonkey ids to delete, for scripts dropped from the document. */
  remove: number[]
  /** Records to carry forward untouched, for everything not being written. */
  keep: Record<string, AppliedUserscript>
}

function entryFrom(installed: InstalledUserscript): UserscriptEntry | null {
  try {
    const parsed = parseUserscript(installed.code)
    return {
      id: userscriptId(parsed.metadata.namespace, parsed.metadata.name),
      name: parsed.metadata.name,
      source: installed.code,
      enabled: installed.enabled
    }
  } catch {
    // A script Violentmonkey accepted but Once cannot parse stays where it is,
    // rather than entering a synced document no other device could read.
    return null
  }
}

/**
 * A record whose script is gone from Violentmonkey means the user deleted it
 * there — unless Violentmonkey lost its storage, where every record would
 * read the same way and adopting that would empty the synced document. One
 * surviving script is enough to tell the two apart.
 */
function storageIntact(
  installed: readonly InstalledUserscript[],
  applied: Readonly<Record<string, AppliedUserscript>>
): boolean {
  if (installed.length === 0) return false
  const ids = new Set(installed.map((script) => script.id))
  return Object.values(applied).some((record) => ids.has(record.id))
}

interface PlanState {
  scripts: UserscriptEntry[]
  plan: Omit<UserscriptPlan, "document" | "adopted">
  seen: Set<string>
  usedIds: Set<number>
}

export type Hash = (value: string) => string

/** Takes the dashboard's version of a script into the document. */
function adopt(state: PlanState, installed: InstalledUserscript, hash: Hash): boolean {
  const entry = entryFrom(installed)
  // Claimed either way: a script Once cannot adopt, or one whose name another
  // entry already holds, still belongs to Violentmonkey and is not deleted.
  state.usedIds.add(installed.id)
  if (!entry || state.seen.has(entry.id)) return false
  state.seen.add(entry.id)
  state.scripts.push(entry)
  state.plan.keep[entry.id] = {
    id: installed.id,
    source: hash(entry.source),
    code: hash(installed.code),
    enabled: installed.enabled
  }
  return true
}

function planScript(
  state: PlanState,
  script: UserscriptEntry,
  installed: InstalledUserscript | undefined,
  record: AppliedUserscript | undefined,
  deleted: boolean,
  hash: Hash
): boolean {
  if (!installed) {
    // Nothing there: either the dashboard deleted it, which drops it from the
    // document, or it is new here and has to be written.
    if (deleted) return true
    state.seen.add(script.id)
    state.scripts.push(script)
    state.plan.install.push(script)
    return false
  }
  state.usedIds.add(installed.id)
  const documentMoved = !record?.source || hash(script.source) !== record.source
  const dashboardMoved = Boolean(record?.code) && hash(installed.code) !== record?.code
  // A dashboard edit is adopted only when the document itself stood still.
  // When both moved the synced text wins: it is the copy the user's other
  // devices are already running, and the one they can still see.
  if (dashboardMoved && !documentMoved) return adopt(state, installed, hash)
  state.seen.add(script.id)
  const outsideToggle = record?.enabled !== undefined && installed.enabled !== record.enabled
  const enabled = outsideToggle && !documentMoved ? installed.enabled : script.enabled
  state.scripts.push({ ...script, enabled })
  if (documentMoved) {
    state.plan.install.push({ ...script, enabled })
    return enabled !== script.enabled
  }
  state.plan.keep[script.id] = { ...record, id: installed.id, enabled }
  if (installed.enabled !== enabled) state.plan.toggle.push({ id: installed.id, enabled })
  return enabled !== script.enabled
}

/**
 * What to write where, given the document, what Violentmonkey holds, and what
 * the last hand-off left behind. Pure: the caller performs the writes and
 * records their result.
 */
export function planUserscripts(
  document: UserscriptsDocument,
  installed: readonly InstalledUserscript[],
  applied: Readonly<Record<string, AppliedUserscript>>,
  hash: Hash,
  knownStorage = false
): UserscriptPlan {
  const byVmId = new Map(installed.map((script) => [script.id, script]))
  const byKey = new Map(
    installed.map((script) => [userscriptId(script.namespace, script.name), script])
  )
  const intact = knownStorage || storageIntact(installed, applied)
  const state: PlanState = {
    scripts: [],
    plan: { install: [], toggle: [], remove: [], keep: {} },
    seen: new Set(),
    usedIds: new Set()
  }
  let adopted = false
  for (const script of document.scripts) {
    const record = applied[script.id]
    const current = (record && byVmId.get(record.id)) || byKey.get(script.id)
    // A record with nothing behind it, on a Violentmonkey that still holds its
    // other scripts, is a deletion made in the dashboard: it drops out here.
    const deleted = !current && Boolean(record) && intact
    if (planScript(state, script, current, record, deleted, hash)) adopted = true
  }
  // What is left is a script the dashboard installed on its own, and it joins
  // the document — unless Once put it there, in which case its absence from
  // the document is a deletion made in Once and the removal below carries it.
  const recorded = new Set(Object.values(applied).map((record) => record.id))
  for (const script of installed) {
    if (state.usedIds.has(script.id) || recorded.has(script.id)) continue
    if (adopt(state, script, hash)) adopted = true
  }
  for (const [id, record] of Object.entries(applied)) {
    if (state.seen.has(id) || state.usedIds.has(record.id)) continue
    if (byVmId.has(record.id)) state.plan.remove.push(record.id)
  }
  return {
    ...state.plan,
    document: { version: USERSCRIPTS_VERSION, scripts: state.scripts },
    adopted
  }
}
