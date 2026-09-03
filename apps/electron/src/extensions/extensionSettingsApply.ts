// Hands Once's synced documents to the extensions that act on them, through
// the same message APIs their own dashboards use. Each adapter is written
// against one extension's public commands and says so; a new extension on
// the allowlist that wants Once's settings gets its own adapter here.

import { promises as fs } from "node:fs"
import path from "node:path"
import { FilterListSubscription, UserscriptEntry } from "@once/core"
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

interface AppliedScripts {
  /** Once userscript id → Violentmonkey script id. */
  ids: Record<string, number>
}

async function readApplied(file: string): Promise<AppliedScripts> {
  try {
    const parsed: unknown = JSON.parse(await fs.readFile(file, "utf8"))
    const ids = (parsed as { ids?: unknown } | null)?.ids
    return { ids: typeof ids === "object" && ids !== null ? ids as Record<string, number> : {} }
  } catch {
    return { ids: {} }
  }
}

/**
 * Violentmonkey's dashboard installs and edits through `runtime.sendMessage`
 * commands: `ParseScript` installs or updates by namespace and name and
 * answers with the script record, `UpdateScriptInfo` toggles it, and
 * `RemoveScripts` deletes by id. The ids Violentmonkey assigns are remembered
 * beside the extension's storage so a script Once no longer lists is removed.
 */
export async function applyUserscriptsToViolentmonkey(
  host: ExtensionHost,
  scripts: readonly UserscriptEntry[],
  storageRoot: string
): Promise<void> {
  const file = path.join(storageRoot, host.extension.host, "once-userscripts.json")
  const applied = await readApplied(file)
  await host.contexts.whenListening("runtime", "onMessage", STARTUP_TIMEOUT_MS)
  const context = new VirtualContext(host)
  try {
    const next: Record<string, number> = {}
    for (const script of scripts) {
      const result = await context.sendMessage({
        cmd: "ParseScript",
        data: { code: script.source, message: "", url: "", from: "" }
      }) as { update?: { props?: { id?: number } }; errors?: unknown } | undefined
      const id = result?.update?.props?.id
      if (typeof id !== "number") {
        console.error(`Violentmonkey did not install "${script.name}"`, result?.errors ?? result)
        continue
      }
      next[script.id] = id
      await context.sendMessage({
        cmd: "UpdateScriptInfo",
        data: { id, config: { enabled: script.enabled ? 1 : 0 } }
      })
    }
    const stale = Object.entries(applied.ids)
      .filter(([onceId]) => !(onceId in next))
      .map(([, vmId]) => vmId)
    if (stale.length > 0) {
      await context.sendMessage({ cmd: "RemoveScripts", data: stale })
    }
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, JSON.stringify({ ids: next }), "utf8")
  } finally {
    context.close()
  }
}

/** Which of Once's documents this extension takes, if any. */
export async function applySettingsToExtension(
  host: ExtensionHost,
  settings: ElectronExtensionSettings,
  storageRoot: string
): Promise<void> {
  if (host.extension.id === UBLOCK_ORIGIN_ID) {
    await applyFilterListsToUblock(host, settings.filterLists.lists)
  } else if (host.extension.id === VIOLENTMONKEY_ID) {
    await applyUserscriptsToViolentmonkey(host, settings.userscripts.scripts, storageRoot)
  }
}
