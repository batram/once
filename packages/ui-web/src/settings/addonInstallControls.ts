import { OnceClient } from "@once/app"
import { AddonEntry, readInstalledAddon, upsertAddon } from "@once/core"
import { requireElement } from "../dom"
import { reportSettingsStatus } from "./settingsStatus"
import { prepareAddon } from "../addons/addonPackage"
import { addonButton, bindAddonManagement } from "./addonManagement"
import { bindAddonFileImport } from "./addonFileImport"
import { bindAddonSettingsPages } from "./AddonSettingsPages"

/**
 * Installing from a URL and checking for updates. A package is a directory
 * with `once-addon.json` beside its script; the manifest's URL is remembered
 * on the entry, so "check for updates" refetches it and replaces the entry
 * when the version moved. Code is never in the document: the sandbox host
 * fetches it by the pinned hash.
 */
export function bindAddonInstallControls(client: OnceClient, onChanged: () => void): void {
  const input = requireElement<HTMLInputElement>("#addon_url_input")
  const install = requireElement<HTMLButtonElement>('[data-testid="install-addon"]')
  const update = requireElement<HTMLButtonElement>('[data-testid="update-addons"]')
  const block = requireElement<HTMLElement>("#addon_install_settings")
  bindAddonManagement(client, block)
  const previews = document.createElement("div")
  previews.id = "addon_previews"
  block.append(previews)

  const say = (text: string, failed = false): void => {
    reportSettingsStatus(install, failed ? "failed" : "saved")
    const status = install.closest(".settings_editor")?.querySelector<HTMLElement>(":scope > .settings_status")
    if (status) status.textContent = text
  }

  const fetchEntry = async (url: string): Promise<AddonEntry> => {
    const read = readInstalledAddon(await client.fetchText(url), url)
    if (!read.ok) {
      const first = read.reports[0]
      throw new Error(`${first.path ? `${first.path} ` : ""}${first.message}`)
    }
    return read.entry
  }

  const preview = async (entry: AddonEntry, code: string | null = null): Promise<void> => {
    const existing = (await client.getAddons()).addons.find(item => item.manifest.id === entry.manifest.id)
    const baseline = JSON.stringify(existing?.manifest)
    const panel = document.createElement("fieldset")
    panel.className = "settings_group"
    const title = document.createElement("legend")
    title.textContent = existing
      ? `${entry.manifest.name}: ${existing.manifest.version} → ${entry.manifest.version}`
      : `Install ${entry.manifest.name} ${entry.manifest.version}`
    const grants = document.createElement("p")
    const added = entry.manifest.capabilities.filter(grant => !existing?.manifest.capabilities.includes(grant))
    grants.textContent = `Network access: ${entry.manifest.capabilities.join(", ") || "none"}` +
      (existing && added.length ? `; newly requested: ${added.join(", ")}` : "") +
      (entry.manifest.connections?.length ? `; configured connections: ${entry.manifest.connections.map(connection => `${connection.id} (destination from ${connection.endpoint}${connection.secret ? ", device-local token" : ""})`).join(", ")}` : "") +
      (entry.manifest.trays?.length ? "; trays can read the invoked story's article content" : "")
    const feedback = document.createElement("p")
    feedback.setAttribute("role", "status")
    const confirm = addonButton(existing ? "Apply update" : "Confirm install", async () => {
      feedback.textContent = "Verifying package…"
      const projected = upsertAddon(await client.getAddons(), entry).addons.find(item => item.manifest.id === entry.manifest.id)
      if (!projected) throw new Error("The add-on could not be prepared")
      if (code !== null && entry.manifest.script) await client.storeAddonScript(entry.manifest.script.integrity, code)
      await prepareAddon(client, projected)
      await client.updateAddons(doc => {
        const current = doc.addons.find(item => item.manifest.id === entry.manifest.id)
        if (JSON.stringify(current?.manifest) !== baseline) throw new Error("This add-on changed; check it again before applying")
        return upsertAddon(doc, entry)
      })
      panel.remove()
      say(`${existing ? "Updated" : "Installed"} ${entry.manifest.name} ${entry.manifest.version}`)
      onChanged()
      block.dispatchEvent(new CustomEvent("once:addon-installed", { detail: `${existing ? "Updated" : "Installed"} ${entry.manifest.name}` }))
    })
    confirm.dataset.testid = "confirm-addon"
    const actions = document.createElement("div")
    actions.className = "settings_actions cluster"
    actions.append(confirm, addonButton("Cancel", () => panel.remove()))
    panel.append(title, grants, feedback, actions)
    previews.append(panel)
    block.dispatchEvent(new Event("once:addon-review"))
  }

  bindAddonFileImport(block, async pack => { previews.replaceChildren(); await preview(pack.entry, pack.code) })

  install.addEventListener("click", () => void (async () => {
    const url = input.value.trim()
    if (!/^https?:\/\//i.test(url)) {
      say("Enter the http(s) URL of an add-on's once-addon.json", true)
      return
    }
    reportSettingsStatus(install, "saving")
    try {
      const entry = await fetchEntry(url)
      previews.replaceChildren()
      await preview(entry)
      input.value = ""
      say(`Review ${entry.manifest.name} before installing`)
    } catch (error) {
      say(`Could not install: ${error instanceof Error ? error.message : String(error)}`, true)
    }
  })())

  update.addEventListener("click", () => void (async () => {
    reportSettingsStatus(install, "saving")
    const doc = await client.getAddons()
    previews.replaceChildren()
    const updated: string[] = []
    const failed: string[] = []
    for (const entry of doc.addons) {
      if (!entry.source) continue
      try {
        const fresh = await fetchEntry(entry.source.url)
        if (fresh.manifest.id !== entry.manifest.id) throw new Error("the manifest now has a different id")
        if (fresh.manifest.version === entry.manifest.version) continue
        await preview(fresh)
        updated.push(`${fresh.manifest.name} ${fresh.manifest.version}`)
      } catch (error) {
        failed.push(`${entry.manifest.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const checked = doc.addons.filter((entry) => entry.source).length
    const parts = [
      updated.length > 0 ? `Updates available: ${updated.join(", ")}` : `${checked} checked, nothing new`,
      ...failed
    ]
    say(parts.join(" · "), failed.length > 0)
  })())
  bindAddonSettingsPages(block)
}
