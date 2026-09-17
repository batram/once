import { OnceClient } from "@once/app"
import { LocalAddonPackage } from "../addons/localAddonPackage"
import { listBundledAddons } from "../addons/bundledAddons"
import { addonButton } from "./addonManagement"

/**
 * The packages built into Once that are not installed right now: removed
 * ones, offered again through the same review as any import. The section
 * stays out of the page while every bundled package is installed.
 */
export function bindAddonBundledImport(client: OnceClient, parent: HTMLElement, preview: (pack: LocalAddonPackage) => Promise<void>): void {
  const group = document.createElement("fieldset")
  group.className = "settings_group"
  group.id = "addon_bundled_import"
  group.hidden = true
  const legend = document.createElement("legend")
  legend.textContent = "Bundled with Once"
  const hint = document.createElement("p")
  hint.className = "settings_group_hint"
  hint.textContent = "These addons come with Once and were removed. Install one again to get it back."
  const list = document.createElement("div")
  group.append(legend, hint, list)
  parent.append(group)
  let revision = 0
  const render = async (): Promise<void> => {
    const current = ++revision
    const [bundled, doc] = await Promise.all([listBundledAddons(), client.getAddons()])
    if (current !== revision) return
    const installed = new Set(doc.addons.map(entry => entry.manifest.id))
    const missing = bundled.filter(pack => !installed.has(pack.entry.manifest.id))
    list.replaceChildren()
    for (const pack of missing) {
      const row = document.createElement("div")
      row.className = "settings_actions cluster"
      const name = document.createElement("span")
      name.textContent = `${pack.entry.manifest.name} ${pack.entry.manifest.version}`
      const install = addonButton("Install", () => preview(pack))
      install.dataset.testid = `install-bundled-${pack.entry.manifest.id}`
      row.append(name, install)
      list.append(row)
    }
    group.hidden = missing.length === 0
  }
  const refresh = (): void => { void render().catch(error => { hint.textContent = `Could not list bundled add-ons: ${String(error)}` }) }
  client.subscribe("settingsChanged", ({ section }) => { if (section === "addons") refresh() })
  refresh()
}
