// Hands Once's synced documents to the extensions that act on them, through
// the same message APIs their own dashboards use. Each adapter is written
// against one extension's public commands and says so; a new extension on
// the allowlist that wants Once's settings gets its own adapter here.

import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import {
  AppliedUserscript,
  FilterListSubscription,
  handUserscriptsToViolentmonkey,
  UserscriptsDocument
} from "@once/core"
import { ElectronExtensionSettings } from "@once/platform-electron/bridge"
import { ExtensionHost } from "./ExtensionHost"
import { VirtualContext } from "./VirtualContext"

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
  host: ExtensionHost,
  lists: readonly FilterListSubscription[],
  storageRoot: string
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
      port.post({ channel: "dashboard", msgId, msg })
    })
  try {
    const table = await request({ what: "getLists" }) as UblockListTable | undefined
    if (!table || typeof table.available !== "object" || table.available === null) {
      throw new Error("uBlock Origin did not describe its filter lists")
    }
    const file = path.join(storageRoot, host.extension.host, "once-filter-lists.json")
    let previous: Record<string, boolean> = {}
    try {
      const value: unknown = JSON.parse(await fs.readFile(file, "utf8"))
      if (isRecord(value)) previous = Object.fromEntries(Object.entries(value).filter(([, enabled]) => typeof enabled === "boolean")) as Record<string, boolean>
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
    }
    const next = reconcileUblockLists(table, lists, previous)
    // Persist ownership before effects, so an interrupted hand-off can be retried.
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(`${file}.tmp`, JSON.stringify({ ...previous, ...next.baseline }), "utf8")
    await fs.rename(`${file}.tmp`, file)
    await request({ what: "applyFilterListSelection", ...ublockSelection(table, next.lists) })
    await request({ what: "reloadAllFilters" }, RELOAD_TIMEOUT_MS)
    await fs.writeFile(`${file}.tmp`, JSON.stringify(next.baseline), "utf8")
    await fs.rename(`${file}.tmp`, file)
  } finally {
    port.disconnect()
    context.close()
  }
}

const APPLIED_VERSION = 3

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const digest = async (value: string): Promise<string> =>
  createHash("sha256").update(value).digest("hex")

/**
 * What the last hand-off left behind, beside the extension's own storage.
 * Version 1 remembered which script was Once's but not what either side held,
 * so those entries carry no baseline: nothing reads as edited, and the first
 * hand-off after an upgrade writes Once's copy and records what it found.
 */
async function readApplied(file: string): Promise<Record<string, AppliedUserscript>> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"))
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
  host: ExtensionHost,
  document: UserscriptsDocument,
  storageRoot: string
): Promise<UserscriptsDocument | undefined> {
  const file = path.join(storageRoot, host.extension.host, "once-userscripts.json")
  const applied = await readApplied(file)
  const generationKey = "onceStorageGeneration"
  const marker = (await host.storage.get(generationKey))[generationKey]
  const generation = typeof marker === "string" ? marker : randomUUID()
  if (typeof marker !== "string") {
    await host.storage.set({ [generationKey]: generation })
    await host.storage.flush()
  }
  let previousGeneration: unknown
  try { previousGeneration = JSON.parse(await fs.readFile(file, "utf8")).generation } catch { /* first hand-off */ }
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
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      `${file}.tmp`,
      JSON.stringify({ version: APPLIED_VERSION, generation, scripts: result.applied }),
      "utf8"
    )
    await fs.rename(`${file}.tmp`, file)
    return result.adopted
  } finally {
    context.close()
  }
}

/** What a hand-off asks the shell to write back into its own documents. */
export interface AdoptedExtensionSettings {
  userscripts?: UserscriptsDocument
}

/** Which of Once's documents this extension takes, if any. */
export async function applySettingsToExtension(
  host: ExtensionHost,
  settings: ElectronExtensionSettings,
  storageRoot: string
): Promise<AdoptedExtensionSettings> {
  if (host.extension.id === UBLOCK_ORIGIN_ID) {
    await applyFilterListsToUblock(host, settings.filterLists.lists, storageRoot)
  } else if (host.extension.id === VIOLENTMONKEY_ID) {
    const userscripts = await applyUserscriptsToViolentmonkey(
      host, settings.userscripts, storageRoot
    )
    if (userscripts) return { userscripts }
  }
  return {}
}
