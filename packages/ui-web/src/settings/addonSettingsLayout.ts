import { requireClosestElement } from "../dom"

export function addonPageAction(text: string, testid: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "button"
  button.textContent = text
  button.dataset.testid = testid
  button.addEventListener("click", run)
  return button
}

export function createAddonSettingsLayout(root: HTMLElement, navigate: (target: string) => void) {
  const find = <T extends HTMLElement>(selector: string): T => {
    const element = root.querySelector<T>(selector)
    if (!element) throw new Error(`Missing addon setting: ${selector}`)
    return element
  }
  const action = addonPageAction
  const page = (id: string, title?: string): HTMLElement => {
    const element = document.createElement("div")
    element.id = `addon_${id}`
    element.className = "addon_page"
    element.hidden = true
    if (title) {
      const heading = document.createElement("h2")
      heading.textContent = title
      heading.tabIndex = -1
      element.append(heading)
    }
    return element
  }
  const overview = page("overview")
  const intro = document.createElement("p")
  intro.className = "settings_group_hint"
  intro.textContent = "Add new features to Once. Open an addon to manage it and change its settings."
  const toolbar = document.createElement("div")
  toolbar.className = "settings_actions cluster"
  const importButton = action("Import addon…", "open-addon-import", () => navigate("import"))
  importButton.classList.add("addon_primary_action")
  const update = find<HTMLButtonElement>('[data-testid="update-addons"]')
  toolbar.append(importButton, update)
  const count = document.createElement("h2")
  count.className = "settings_subheading"
  const list = document.createElement("div")
  list.id = "addon_list"
  list.setAttribute("aria-label", "Once Add-ons")
  const empty = document.createElement("p")
  empty.className = "settings_group_hint"
  empty.textContent = "No addons yet. Import a ZIP, choose a folder, or use a manifest URL to get started."
  const advancedButton = action("Advanced: edit addon JSON…", "open-addon-advanced", () => navigate("advanced"))
  advancedButton.classList.add("addon_advanced_action")
  const notice = document.createElement("p")
  notice.setAttribute("role", "status")
  overview.append(intro, toolbar, notice, count, empty, list, advancedButton)

  const imports = page("import", "Import an addon")
  imports.classList.add("settings_editor")
  const files = page("file_import", "From a ZIP or folder")
  files.hidden = false
  files.className = "addon_import_method"
  const picker = requireClosestElement(find('[data-testid="import-addon-zip"]'), ".settings_actions")
  const hint = picker.nextElementSibling
  const feedback = hint?.nextElementSibling
  files.append(picker)
  if (hint) files.append(hint)
  if (feedback) files.append(feedback)
  const directories = document.createElement("div")
  directories.id = "addon_directory_import"
  // A native directory source can bind before or after this navigation.
  const linked = root.querySelector('[data-testid="load-addon-directory"]')?.closest("fieldset")
  if (linked) directories.append(linked)
  const url = document.createElement("section")
  url.className = "addon_import_method"
  const install = find('[data-testid="install-addon"]')
  url.append(requireClosestElement(find("#addon_url_input"), ".field"), requireClosestElement(install, ".settings_actions"))
  const firefox = find("#firefox_addon_sandbox_settings")
  imports.append(files, directories, url, firefox, find("#addon_previews"))
  const details = page("detail")
  const installed = find("#addon_installed")
  const options = find("#addon_options")
  details.append(installed, options)
  const advanced = find("#addon_advanced")
  advanced.classList.add("addon_page")
  root.append(overview, imports, details, advanced)

  return { overview, imports, details, advanced, importButton, update, list, count, empty, notice }
}
