import type { OnceClient } from "@once/app"
import { requireElement } from "../dom"
import { showConfirmDialog } from "../confirmDialog"

/** Storage is read on demand; never scan the database on every tab update. */
export function bindTabSyncStorageControls(client: OnceClient): void {
  const output = requireElement<HTMLElement>("#tab_sync_storage_status")
  const buttons = ["tab_sync_storage_refresh", "tab_sync_storage_clean", "tab_sync_remove_inactive"]
    .map((id) => requireElement<HTMLButtonElement>(`#${id}`))
  const refresh = async () => {
    const stats = await client.getTabSyncStorage()
    const count = (value: number, label: string) => `${value} ${label}${value === 1 ? "" : "s"}`
    const bytes = `${(stats.screenshotBytes / 1024 / 1024).toFixed(2)} MB`
    output.textContent = `${count(stats.devices, "device")} · ${count(stats.screenshots, "screenshot")} (${bytes}) · ${count(stats.sends, "queued send")} · ${count(stats.retirements, "removal record")}. ` +
      `Last completed cleanup: ${stats.lastCompletedAt ? new Date(stats.lastCompletedAt).toLocaleString() : "not yet"}. ` +
      (stats.pending ? "More cleanup is queued; run again or leave sync on to finish. " : "") +
      (stats.database.doc_del_count === undefined ? "Deleted-record count is unavailable in this local adapter." : `${stats.database.doc_del_count} deleted records in the local database.`)
    if (stats.server) {
      const server = stats.server
      output.textContent += ` Server: ${server.doc_count ?? "unknown"} live records, ${server.doc_del_count ?? "unknown"} deleted records.`
      if (server.sizes) output.textContent += ` ${(Number(server.sizes.file ?? 0) / 1048576).toFixed(2)} MB allocated, ${(Number(server.sizes.active ?? 0) / 1048576).toFixed(2)} MB active.`
      output.textContent += server.compact_running === undefined ? " Compaction status is unavailable." : server.compact_running ? " Compaction is running." : " Compaction is not running."
    } else output.textContent += stats.serverUnavailable ? " Server storage could not be read; check the connection and try again." : " Server storage details are unavailable."
  }
  const run = async (work: () => Promise<void>) => {
    const focus = document.activeElement as HTMLElement | null
    buttons.forEach((button) => { button.disabled = true })
    output.textContent = "Checking storage…"
    try { await work(); await refresh() }
    catch (error) { output.textContent = error instanceof Error ? error.message : "Storage could not be checked. Try again." }
    finally {
      buttons.forEach((button) => { button.disabled = false })
      if (document.activeElement === document.body) focus?.focus({ preventScroll: true })
    }
  }
  buttons[0].addEventListener("click", () => void run(async () => undefined))
  buttons[1].addEventListener("click", () => void run(() => client.cleanTabSyncStorage()))
  buttons[2].addEventListener("click", () => void run(async () => {
    const view = await client.getTabSync()
    const inactive = view?.devices.filter((device) => device.stale) ?? []
    if (!inactive.length) return
    const confirmed = await showConfirmDialog({
      message: `Remove these inactive devices and their saved tabs, screenshots and queued sends: ${inactive.map((device) => device.name).join(", ")}? They must turn tab sync off and on to rejoin.`,
      confirmLabel: "Remove inactive devices"
    })
    if (confirmed) await client.removeInactiveDevices(inactive.map((device) => device.deviceId))
  }))
}
