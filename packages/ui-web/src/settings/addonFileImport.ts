import { LocalAddonPackage, readAddonFolder, readAddonZip } from "../addons/localAddonPackage"
import { addonButton } from "./addonManagement"

export function bindAddonFileImport(parent: HTMLElement, preview: (pack: LocalAddonPackage) => Promise<void>): void {
  const actions = document.createElement("div")
  actions.className = "settings_actions cluster"
  const status = document.createElement("p")
  status.setAttribute("role", "status")
  const addPicker = (folder: boolean) => {
    const input = document.createElement("input")
    input.type = "file"
    input.hidden = true
    input.dataset.testid = folder ? "addon-folder-file" : "addon-zip-file"
    input.setAttribute("aria-label", folder ? "Addon folder" : "Addon ZIP file")
    if (folder) { input.webkitdirectory = true; input.multiple = true }
    else input.accept = ".zip,application/zip,application/x-zip-compressed"
    const button = addonButton(folder ? "Import folder…" : "Import ZIP…", () => input.click())
    button.dataset.testid = folder ? "import-addon-folder" : "import-addon-zip"
    input.addEventListener("change", () => {
      const files = Array.from(input.files ?? [])
      input.value = ""
      if (!files.length) return
      button.disabled = true
      status.textContent = "Reading addon package…"
      void (folder ? readAddonFolder(files) : readAddonZip(files[0]))
        .then(async pack => { await preview(pack); status.textContent = `Review ${pack.entry.manifest.name} below to finish installing.` })
        .catch(error => { status.textContent = `Could not import: ${error instanceof Error ? error.message : String(error)}` })
        .finally(() => { button.disabled = false })
    })
    actions.append(button, input)
  }
  addPicker(false)
  if (document.body.dataset.platform !== "mobile" && "webkitdirectory" in document.createElement("input")) addPicker(true)
  const hint = document.createElement("p")
  hint.className = "settings_group_hint"
  hint.textContent = "Import a ZIP or folder containing once-addon.json and its script. Files are copied into this device's addon cache; reimport to update."
  parent.prepend(actions, hint, status)
}
