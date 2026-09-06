import type { DevAddonSource } from "../addons/mountAddons"
import { addonButton } from "./addonManagement"

export function bindAddonDirectories(source?: DevAddonSource): (entries: Awaited<ReturnType<DevAddonSource["list"]>>) => void {
  const host = document.querySelector("#addon_directory_import") ?? document.querySelector("#addon_install_settings")
  if (!host || !source?.pickDirectory) return () => undefined
  const group = document.createElement("fieldset")
  group.className = "settings_group"
  const legend = document.createElement("legend")
  legend.textContent = "Link a development folder"
  const hint = document.createElement("p")
  hint.className = "settings_group_hint"
  hint.textContent = "Working on an addon? Link its folder to reload it when files change. The link stays on this device; unloading leaves your files intact."
  const status = document.createElement("p")
  status.setAttribute("role", "status")
  const pick = addonButton("Load directory…", async () => {
    try { await source.pickDirectory?.(); status.textContent = "" }
    catch (error) { status.textContent = `Could not load directory: ${error instanceof Error ? error.message : String(error)}` }
  })
  pick.dataset.testid = "load-addon-directory"
  const list = document.createElement("div")
  group.append(legend, hint, pick, status, list)
  host.prepend(group)
  let signature = ""
  return entries => {
    const next = JSON.stringify(entries.map(({ directory, removable, error }) => ({ directory, removable, error })))
    if (signature === next) return
    signature = next
    list.replaceChildren()
    for (const entry of entries) {
      const row = document.createElement("div")
      row.className = "settings_actions cluster"
      const name = document.createElement("span")
      name.textContent = entry.directory + (entry.error ? ` — ${entry.error}` : "")
      row.append(name)
      if (entry.removable && source.removeDirectory) row.append(addonButton("Unload", async () => {
        try { await source.removeDirectory?.(entry.directory) }
        catch (error) { status.textContent = String(error) }
      }))
      list.append(row)
    }
  }
}
