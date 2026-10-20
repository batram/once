// Hands Once's synced documents to the extensions that act on them, through
// the same message APIs their own dashboards use. Each adapter is written
// against one extension's public commands and says so; a new extension on
// the allowlist that wants Once's settings gets its own adapter here.

import {
  AppliedUserscript,
  FilterListSubscription,
  handUserscriptsToViolentmonkey,
  UserscriptsDocument
} from "@once/core"
import { ApiHost } from "./ExtensionApi"
import { AdoptedExtensionSettings, ExtensionSettings } from "./managementTypes"
import { sha256Hex } from "./sha256"
import { VirtualContext } from "./VirtualContext"

const FILTER_LISTS_RECORD = "once-filter-lists.json"
const FILTER_LISTS_PENDING = "once-filter-lists-pending.json"
const USERSCRIPTS_RECORD = "once-userscripts.json"

export const UBLOCK_ORIGIN_ID = "uBlock0@raymondhill.net"
export const VIOLENTMONKEY_ID = "{aecec67f-0d10-4fa7-b7c7-609a2db280cf}"

// These bounds decide when a hand-off is reported as failed, never when it
// is considered done: every step waits for the extension's own answer.
/** A lookup or a settings write; both answer from memory. */
const REPLY_TIMEOUT_MS = 30_000
/** uBlock's `reloadAllFilters` downloads newly imported lists before answering. */
const RELOAD_TIMEOUT_MS = 10 * 60_000
/**
 * Before the first message: a background page registers its handlers at the
 * end of its own start-up, which for Violentmonkey is after awaiting its
 * storage, so the wait is on that registration rather than on the load event.
 */
const STARTUP_TIMEOUT_MS = 60_000

/** `getLists` as uBlock answers it: every known list, `off` when unselected. */
export interface UblockListTable {
  available: Record<string, { contentURL?: string | string[]; off?: boolean }>
}

/** uBlock keys stock lists by name and imported ones by URL; find either. */
function ublockAssetKey(table: UblockListTable, url: string): string | null {
  if (url in table.available) return url
  const needle = url.replace(/^https?:/, "")
  for (const [key, asset] of Object.entries(table.available)) {
    const urls = Array.isArray(asset.contentURL) ? asset.contentURL : [asset.contentURL]
    if (urls.some((candidate) => typeof candidate === "string" && candidate.endsWith(needle))) {
      return key
    }
  }
  return null
}

/**
 * Once's subscriptions are additions to uBlock's own selection, never a
 * replacement: the selection uBlock reports comes back with the enabled
 * lists added and the disabled ones taken out, stock lists by their key and
 * unknown URLs imported.
 */
export function ublockSelection(
  table: UblockListTable,
  lists: readonly FilterListSubscription[]
): { toSelect: string[]; toImport: string; toRemove: string[] } {
  const selected = new Set(
    Object.entries(table.available).filter(([, asset]) => asset.off !== true).map(([key]) => key)
  )
  const toImport: string[] = []
  const toRemove: string[] = []
  for (const list of lists) {
    const key = ublockAssetKey(table, list.url)
    if (list.enabled) {
      if (key) selected.add(key)
      else toImport.push(list.url)
    } else if (key) {
      selected.delete(key)
      if (key === list.url) toRemove.push(key)
    }
  }
  return { toSelect: [...selected], toImport: toImport.join("\n"), toRemove }
}

/** Remember the selection that existed before Once managed each URL. */
export function reconcileUblockLists(
  table: UblockListTable,
  lists: readonly FilterListSubscription[],
  previous: Record<string, boolean>
): { lists: FilterListSubscription[]; baseline: Record<string, boolean> } {
  const baseline: Record<string, boolean> = {}
  for (const list of lists) {
    const key = ublockAssetKey(table, list.url)
    baseline[list.url] = previous[list.url] ?? (key !== null && table.available[key].off !== true)
  }
  const removed = Object.entries(previous).filter(([url]) => !(url in baseline))
    .map(([url, enabled]) => ({ url, enabled }))
  return { lists: [...lists, ...removed], baseline }
}

/**
 * uBlock's dashboard talks to its background over a port with
 * `{ channel, msgId, msg }` envelopes and gets `{ msgId, msg }` back. The
 * "dashboard" channel carries `getLists`, `applyFilterListSelection`, and
 * `reloadAllFilters`, which is the sequence its own 3rd-party filters page
 * runs when the user presses Apply.
 */
export async function applyFilterListsToUblock(
  host: ApiHost,
  lists: readonly FilterListSubscription[]
): Promise<void> {
  await host.contexts.whenListening("runtime", "onConnect", STARTUP_TIMEOUT_MS)
  const context = new VirtualContext(host)
  const port = context.connectPort("once-settings")
  const pending = new Map<number, (reply: unknown) => void>()
  let nextId = 1
  port.onMessage((reply) => {
    const envelope = reply as { msgId?: number; msg?: unknown } | null
    if (envelope && typeof envelope.msgId === "number") {
      pending.get(envelope.msgId)?.(envelope.msg)
      pending.delete(envelope.msgId)
    }
  })
  const request = (msg: { what: string }, timeoutMs = REPLY_TIMEOUT_MS): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const msgId = nextId++
      const timer = setTimeout(() => {
        pending.delete(msgId)
        reject(new Error(`uBlock Origin did not answer ${msg.what}`))
      }, timeoutMs)
      pending.set(msgId, (value) => {
        clearTimeout(timer)
        resolve(value)
      })
      try {
        port.post({ channel: "dashboard", msgId, msg })
      } catch (error) {
        clearTimeout(timer)
        pending.delete(msgId)
        reject(error)
      }
    })
  try {
    const table = await request({ what: "getLists" }) as UblockListTable | undefined
    if (!table || typeof table.available !== "object" || table.available === null) {
      throw new Error("uBlock Origin did not describe its filter lists")
    }
    let previous: Record<string, boolean> = {}
    const value = await host.store.read(FILTER_LISTS_RECORD)
    if (isRecord(value)) previous = Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === "boolean")) as Record<string, boolean>
    const next = reconcileUblockLists(table, lists, previous)
    const selection = ublockSelection(table, next.lists)
    const selected = Object.entries(table.available).filter(([, asset]) => asset.off !== true).map(([key]) => key)
    const changed = selection.toImport !== "" || selection.toRemove.length > 0 ||
      selected.length !== selection.toSelect.length || selected.some((key) => !selection.toSelect.includes(key))
    const unfinished = await host.store.read(FILTER_LISTS_PENDING)
    if (!changed && unfinished !== true) {
      // getLists waits for uBlock's initial filters. An already-correct
      // selection needs no rebuild, including after a broker restart.
      // Still record newly managed URLs and forget released ownership.
      await host.store.write(FILTER_LISTS_RECORD, next.baseline)
      return
    }
    // Persist ownership before effects, so an interrupted hand-off can be retried.
    await host.store.write(FILTER_LISTS_RECORD, { ...previous, ...next.baseline })
    await host.store.write(FILTER_LISTS_PENDING, true)
    await request({ what: "applyFilterListSelection", ...selection })
    await request({ what: "reloadAllFilters" }, RELOAD_TIMEOUT_MS)
    await host.store.write(FILTER_LISTS_RECORD, next.baseline)
    await host.store.write(FILTER_LISTS_PENDING, false)
  } finally {
    port.disconnect()
    context.close()
  }
}

const APPLIED_VERSION = 3

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const digest = async (value: string): Promise<string> => sha256Hex(value)

/**
 * What the last hand-off left behind, beside the extension's own storage.
 * Version 1 remembered which script was Once's but not what either side held,
 * so those entries carry no baseline: nothing reads as edited, and the first
 * hand-off after an upgrade writes Once's copy and records what it found.
 */
async function readApplied(host: ApiHost): Promise<Record<string, AppliedUserscript>> {
  try {
    const parsed = await host.store.read(USERSCRIPTS_RECORD)
    if (!isRecord(parsed)) return {}
    if ((parsed.version === APPLIED_VERSION || parsed.version === 2) && isRecord(parsed.scripts)) {
      return parsed.scripts as Record<string, AppliedUserscript>
    }
    if (!isRecord(parsed.ids)) return {}
    return Object.fromEntries(
      Object.entries(parsed.ids)
        .filter(([, id]) => typeof id === "number")
        .map(([onceId, id]) => [onceId, { id: id as number }])
    )
  } catch {
    return {}
  }
}

/**
 * Hands the document to Violentmonkey through its dashboard's commands, with
 * the record of the last hand-off kept in a file beside its storage. A
 * generation marker inside Violentmonkey's storage tells a deletion made in
 * the dashboard apart from storage that was lost while the file survived.
 */
export async function applyUserscriptsToViolentmonkey(
  host: ApiHost,
  document: UserscriptsDocument
): Promise<UserscriptsDocument | undefined> {
  const applied = await readApplied(host)
  const generationKey = "onceStorageGeneration"
  const marker = (await host.storage.get(generationKey))[generationKey]
  const generation = typeof marker === "string" ? marker : crypto.randomUUID()
  if (typeof marker !== "string") {
    await host.storage.set({ [generationKey]: generation })
    await host.storage.flush()
  }
  let previousGeneration: unknown
  try {
    previousGeneration = ((await host.store.read(USERSCRIPTS_RECORD)) as { generation?: unknown } | undefined)?.generation
  } catch { /* first hand-off */ }
  await host.contexts.whenListening("runtime", "onMessage", STARTUP_TIMEOUT_MS)
  const context = new VirtualContext(host)
  try {
    const result = await handUserscriptsToViolentmonkey(
      (cmd, data) => context.sendMessage({ cmd, data }),
      document,
      applied,
      digest,
      previousGeneration === generation
    )
    await host.store.write(USERSCRIPTS_RECORD, { version: APPLIED_VERSION, generation, scripts: result.applied })
    return result.adopted
  } finally {
    context.close()
  }
}

/** Which of Once's documents this extension takes, if any. */
export async function applySettingsToExtension(
  host: ApiHost,
  settings: ExtensionSettings
): Promise<AdoptedExtensionSettings> {
  if (host.extension.id === UBLOCK_ORIGIN_ID) {
    await applyFilterListsToUblock(host, settings.filterLists.lists)
  } else if (host.extension.id === VIOLENTMONKEY_ID) {
    const userscripts = await applyUserscriptsToViolentmonkey(host, settings.userscripts)
    if (userscripts) return { userscripts }
  }
  return {}
}
