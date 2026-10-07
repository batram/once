import { requireClosestElement } from "../dom"
import { SYNC_PAGE_EVENT, type SyncPage } from "./syncSettingsPages"

export function addonPageAction(text: string, testid: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "button"
  button.textContent = text
  button.dataset.testid = testid
  button.addEventListener("click", run)
  return button
}

/**
 * Add-on sync lives in Settings › Sync; this row, last in the list, leads
 * there. It is built like an add-on's row (name, what it does, a status line)
 * but is not one: it carries no `addon_list_row`, so nothing counts it. Its
 * state comes from addonVaultControls. Locked or in conflict the list is
 * otherwise empty, so the row is at the top exactly when it needs attention.
 * A shell without that page keeps the vault controls on this page instead.
 */
function addonSyncLink(): HTMLElement[] {
  if (!document.querySelector("#sync_page_addons")) return []
  const link = document.createElement("button")
  link.type = "button"
  link.className = "addon_sync_link"
  link.dataset.testid = "open-addon-sync"
  link.dataset.addonSyncLink = ""
  const name = document.createElement("strong")
  name.textContent = "Add-on sync"
  const description = document.createElement("span")
  description.className = "addon_list_description"
  description.textContent = "Keeps your add-ons, their settings and tokens the same on all your devices, encrypted."
  const meta = document.createElement("span")
  meta.className = "addon_list_meta"
  const state = document.createElement("span")
  state.className = "addon_sync_link_state"
  state.dataset.addonSyncSummary = ""
  meta.append(state, " · Settings › Sync")
  const arrow = document.createElement("span")
  arrow.className = "addon_list_arrow"
  arrow.setAttribute("aria-hidden", "true")
  arrow.textContent = "›"
  link.append(name, description, meta, arrow)
  // Already in Settings: switch section, without the menu button that toggles the panel.
  link.addEventListener("click", () => {
    document.querySelector<HTMLButtonElement>("[data-settings-target=\"sync\"]")?.click()
    document.dispatchEvent(new CustomEvent<SyncPage>(SYNC_PAGE_EVENT, { detail: "addons" }))
  })
  return [link]
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
  // The list is the page: its heading carries the actions and, beside them,
  // what the last one did; updates are reviewed right there, above the
  // add-ons they replace. Importing is its own page.
  const overview = page("overview")
  const header = document.createElement("div")
  header.className = "addon_overview_header"
  const count = document.createElement("h2")
  count.className = "settings_subheading"
  const toolbar = document.createElement("div")
  toolbar.className = "addon_overview_actions"
  const importButton = action("Import add-on…", "open-addon-import", () => navigate("import"))
  importButton.classList.add("addon_primary_action")
  const update = find<HTMLButtonElement>('[data-testid="update-addons"]')
  // What the last action did, read beside the buttons that did it.
  const notice = document.createElement("span")
  notice.className = "addon_overview_status"
  notice.dataset.testid = "addon-overview-status"
  notice.setAttribute("role", "status")
  toolbar.append(notice, update, importButton)
  header.append(count, toolbar)
  const updates = document.createElement("div")
  updates.id = "addon_updates"
  const list = document.createElement("div")
  list.id = "addon_list"
  list.setAttribute("aria-label", "Once Add-ons")
  list.append(...addonSyncLink())
  const empty = document.createElement("p")
  empty.className = "settings_group_hint addon_list_empty"
  empty.textContent = "Add-ons add new features to Once. None are installed yet: import a ZIP, choose a folder, or use a manifest URL to get started."
  const advancedButton = action("Advanced: edit add-on JSON…", "open-addon-advanced", () => navigate("advanced"))
  advancedButton.classList.add("addon_advanced_action")
  overview.append(header, updates, empty, list, advancedButton)

  const imports = page("import", "Import an add-on")
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
  const bundled = root.querySelector("#addon_bundled_import")
  imports.append(files, directories, url, ...(bundled ? [bundled] : []), find("#addon_previews"))
  const details = page("detail")
  const installed = find("#addon_installed")
  const options = find("#addon_options")
  details.append(installed, options)
  const advanced = find("#addon_advanced")
  advanced.classList.add("addon_page")
  root.append(overview, imports, details, advanced)

  return { overview, imports, details, advanced, importButton, list, count, empty, notice }
}
