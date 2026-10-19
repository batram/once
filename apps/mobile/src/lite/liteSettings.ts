// The shell's synced filter lists and userscripts (`applyExtensionSettings`
// on the surface plugin, relayed by Java as `settings.apply`) reach the
// bundled extensions through the shared coordinator and the Electron
// adapters: uBlock Origin over its dashboard port, through a `VirtualContext`.
// Userscripts are not applied here: on Android the shell hands them to
// Violentmonkey itself through the `GeckoViolentmonkey` plugin contract,
// which `liteViolentmonkey.ts` answers, so applying them a second time from
// the coordinator would make each hand-off read the other's writes as
// dashboard edits.

import {
  AdoptedExtensionSettings,
  ApiHost,
  ExtensionSettings,
  ExtensionSettingsCoordinator,
  UBLOCK_ORIGIN_ID,
  VirtualContext,
  applyFilterListsToUblock
} from "@once/webext-runtime"
import { emptyUserscriptsDocument } from "@once/core"
import { SettingsParams } from "./protocol"

const STARTUP_TIMEOUT_MS = 60_000

/**
 * Resolves once uBlock's background answers `getLists` on its dashboard
 * channel, which it does only after its start-up has loaded the filter
 * lists (`isReadyPromise`) and any `reloadAllFilters` has finished. Rejects
 * after `timeoutMs`.
 */
export async function waitForUblockLists(host: ApiHost, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs
  await host.contexts.whenListening("runtime", "onConnect", Math.min(timeoutMs, STARTUP_TIMEOUT_MS))
  const context = new VirtualContext(host)
  const port = context.connectPort("once-lists")
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("uBlock Origin did not answer getLists")), Math.max(0, deadline - Date.now()))
      port.onMessage((reply) => {
        const envelope = reply as { msgId?: number } | null
        if (envelope?.msgId !== 1) return
        clearTimeout(timer)
        resolve()
      })
      port.post({ channel: "dashboard", msgId: 1, msg: { what: "getLists" } })
    })
  } finally {
    port.disconnect()
    context.close()
  }
}

/** Which of Once's documents an extension takes on Lite: uBlock's lists only. */
export async function applyLiteSettings(host: ApiHost, settings: ExtensionSettings): Promise<AdoptedExtensionSettings> {
  if (host.extension.id === UBLOCK_ORIGIN_ID) {
    await applyFilterListsToUblock(host, settings.filterLists.lists)
    // `reloadAllFilters` answers after loading; this confirms the lists are in force before the ack.
    await waitForUblockLists(host, 30_000)
  }
  return {}
}

export function readSettings(params: unknown): ExtensionSettings {
  const record = (params ?? {}) as Partial<SettingsParams>
  const filterLists = record.filterLists as ExtensionSettings["filterLists"] | undefined
  const userscripts = record.userscripts as ExtensionSettings["userscripts"] | undefined
  if (!filterLists || !Array.isArray(filterLists.lists)) throw new Error("Invalid filter lists document")
  return {
    filterLists,
    userscripts: userscripts && Array.isArray(userscripts.scripts) ? userscripts : emptyUserscriptsDocument()
  }
}

export function createLiteSettingsCoordinator(
  hosts: () => Iterable<ApiHost>,
  changed: () => void
): ExtensionSettingsCoordinator {
  return new ExtensionSettingsCoordinator(hosts, changed, applyLiteSettings)
}
