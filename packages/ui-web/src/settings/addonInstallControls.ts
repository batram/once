import { OnceClient } from "@once/app"
import { AddonEntry, readInstalledAddon, upsertAddon } from "@once/core"
import { requireElement } from "../dom"
import { reportSettingsStatus } from "./settingsStatus"

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

  const say = (text: string, failed = false): void => {
    reportSettingsStatus(install, failed ? "failed" : "saved")
    const status = block.querySelector<HTMLElement>(":scope > .settings_status")
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

  install.addEventListener("click", () => void (async () => {
    const url = input.value.trim()
    if (!/^https?:\/\//i.test(url)) {
      say("Enter the http(s) URL of an add-on's once-addon.json", true)
      return
    }
    reportSettingsStatus(install, "saving")
    try {
      const entry = await fetchEntry(url)
      await client.saveAddons(upsertAddon(await client.getAddons(), entry))
      input.value = ""
      say(`Installed ${entry.manifest.name} ${entry.manifest.version}`)
      onChanged()
    } catch (error) {
      say(`Could not install: ${error instanceof Error ? error.message : String(error)}`, true)
    }
  })())

  update.addEventListener("click", () => void (async () => {
    reportSettingsStatus(install, "saving")
    let doc = await client.getAddons()
    const updated: string[] = []
    const failed: string[] = []
    for (const entry of doc.addons) {
      if (!entry.source) continue
      try {
        const fresh = await fetchEntry(entry.source.url)
        if (fresh.manifest.id !== entry.manifest.id) throw new Error("the manifest now has a different id")
        if (fresh.manifest.version === entry.manifest.version) continue
        doc = upsertAddon(doc, fresh)
        updated.push(`${fresh.manifest.name} ${fresh.manifest.version}`)
      } catch (error) {
        failed.push(`${entry.manifest.name}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (updated.length > 0) await client.saveAddons(doc)
    const checked = doc.addons.filter((entry) => entry.source).length
    const parts = [
      updated.length > 0 ? `Updated ${updated.join(", ")}` : `${checked} checked, nothing new`,
      ...failed
    ]
    say(parts.join(" · "), failed.length > 0)
    if (updated.length > 0) onChanged()
  })())
}
