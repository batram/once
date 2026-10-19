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
  applyFilterListsToUblock
} from "@once/webext-runtime"
import { emptyUserscriptsDocument } from "@once/core"
import { SettingsParams } from "./protocol"

/** Which of Once's documents an extension takes on Lite: uBlock's lists only. */
export async function applyLiteSettings(host: ApiHost, settings: ExtensionSettings): Promise<AdoptedExtensionSettings> {
  if (host.extension.id === UBLOCK_ORIGIN_ID) await applyFilterListsToUblock(host, settings.filterLists.lists)
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
