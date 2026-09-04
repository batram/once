// Hands Once's synced documents to the extensions that act on them, through
// the same message APIs their own dashboards use. Each adapter is written
// against one extension's public commands and says so; a new extension on
// the allowlist that wants Once's settings gets its own adapter here.

import { createHash } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { FilterListSubscription, UserscriptEntry, UserscriptsDocument } from "@once/core"
import { ElectronExtensionSettings } from "@once/platform-electron/bridge"
import { ExtensionHost } from "./ExtensionHost"
import {
  AppliedUserscript,
  InstalledUserscript,
  planUserscripts
} from "./userscriptReconcile"
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

/**
 * uBlock's dashboard talks to its background over a port with
 * `{ channel, msgId, msg }` envelopes and gets `{ msgId, msg }` back. The
 * "dashboard" channel carries `getLists`, `applyFilterListSelection`, and
 * `reloadAllFilters`, which is the sequence its own 3rd-party filters page
 * runs when the user presses Apply.
 */
export async function applyFilterListsToUblock(
  host: ExtensionHost,
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
      port.post({ channel: "dashboard", msgId, msg })
    })
  try {
    const table = await request({ what: "getLists" }) as UblockListTable | undefined
    if (!table || typeof table.available !== "object" || table.available === null) {
      throw new Error("uBlock Origin did not describe its filter lists")
    }
    await request({ what: "applyFilterListSelection", ...ublockSelection(table, lists) })
    await request({ what: "reloadAllFilters" }, RELOAD_TIMEOUT_MS)
  } finally {
    port.disconnect()
    context.close()
  }
}

const APPLIED_VERSION = 2

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

const hash = (value: string): string =>
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
    if (parsed.version === APPLIED_VERSION && isRecord(parsed.scripts)) {
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

interface ExportedScript {
  script?: {
    props?: { id?: number }
    meta?: { name?: string; namespace?: string }
    config?: { enabled?: number | boolean; removed?: number | boolean }
  }
  code?: string
}

/**
 * Everything Violentmonkey holds, with its code. `ExportZip` is the one
 * command that answers with both in a single round trip; without `values` it
 * carries no stored script data, only the scripts themselves.
 */
async function installedUserscripts(context: VirtualContext): Promise<InstalledUserscript[]> {
  const result = await context.sendMessage({
    cmd: "ExportZip",
    data: { values: false }
  }) as { items?: ExportedScript[] } | undefined
  const items = Array.isArray(result?.items) ? result.items : []
  const scripts: InstalledUserscript[] = []
  for (const item of items) {
    const id = item?.script?.props?.id
    const name = item?.script?.meta?.name
    const enabled = item?.script?.config?.enabled
    if (typeof id !== "number" || !name || typeof item.code !== "string") continue
    if (item.script?.config?.removed) continue
    scripts.push({
      id,
      name,
      namespace: item.script?.meta?.namespace || null,
      code: item.code,
      enabled: enabled !== 0 && enabled !== false
    })
  }
  return scripts
}

/** Writes one script, then reads back what Violentmonkey stored for it. */
async function installUserscript(
  context: VirtualContext,
  script: UserscriptEntry
): Promise<AppliedUserscript | undefined> {
  const result = await context.sendMessage({
    cmd: "ParseScript",
    data: { code: script.source, message: "", url: "", from: "" }
  }) as { update?: { props?: { id?: number } }; errors?: unknown } | undefined
  const id = result?.update?.props?.id
  if (typeof id !== "number") {
    console.error(`Violentmonkey did not install "${script.name}"`, result?.errors ?? result)
    return undefined
  }
  await context.sendMessage({
    cmd: "UpdateScriptInfo",
    data: { id, config: { enabled: script.enabled ? 1 : 0 } }
  })
  // The baseline has to be the text Violentmonkey ended up with rather than
  // the text Once sent: an install may normalise it, and the difference would
  // otherwise read as a dashboard edit on the very next hand-off.
  const stored = await context.sendMessage({ cmd: "GetScriptCode", data: id })
  return {
    id,
    source: hash(script.source),
    code: hash(typeof stored === "string" ? stored : script.source),
    enabled: script.enabled
  }
}

/**
 * Violentmonkey's dashboard installs and edits through `runtime.sendMessage`
 * commands: `ExportZip` reads every script with its code, `ParseScript`
 * installs or updates by namespace and name, `GetScriptCode` reads one back,
 * `UpdateScriptInfo` toggles it, and `RemoveScripts` deletes by id.
 *
 * The dashboard is an editor in its own right, so this reconciles rather than
 * overwrites: what Once's document changed is written, and what the dashboard
 * changed is returned for the caller to save into the document, where it syncs
 * like any other change.
 */
export async function applyUserscriptsToViolentmonkey(
  host: ExtensionHost,
  document: UserscriptsDocument,
  storageRoot: string
): Promise<UserscriptsDocument | undefined> {
  const file = path.join(storageRoot, host.extension.host, "once-userscripts.json")
  const applied = await readApplied(file)
  await host.contexts.whenListening("runtime", "onMessage", STARTUP_TIMEOUT_MS)
  const context = new VirtualContext(host)
  try {
    const installed = await installedUserscripts(context)
    const plan = planUserscripts(document, installed, applied, hash)
    const next: Record<string, AppliedUserscript> = { ...plan.keep }
    // Deleting takes both commands, as the dashboard's own delete does:
    // `RemoveScripts` purges what is already in Violentmonkey's trash and
    // leaves an installed script running, so it has to be put there first.
    for (const id of plan.remove) {
      await context.sendMessage({ cmd: "MarkRemoved", data: { id, removed: true } })
    }
    if (plan.remove.length > 0) {
      await context.sendMessage({ cmd: "RemoveScripts", data: plan.remove })
    }
    for (const script of plan.install) {
      const record = await installUserscript(context, script)
      if (record) next[script.id] = record
    }
    for (const { id, enabled } of plan.toggle) {
      await context.sendMessage({
        cmd: "UpdateScriptInfo",
        data: { id, config: { enabled: enabled ? 1 : 0 } }
      })
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(
      file,
      JSON.stringify({ version: APPLIED_VERSION, scripts: next }),
      "utf8"
    )
    return plan.adopted ? plan.document : undefined
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
    await applyFilterListsToUblock(host, settings.filterLists.lists)
  } else if (host.extension.id === VIOLENTMONKEY_ID) {
    const userscripts = await applyUserscriptsToViolentmonkey(
      host, settings.userscripts, storageRoot
    )
    if (userscripts) return { userscripts }
  }
  return {}
}
