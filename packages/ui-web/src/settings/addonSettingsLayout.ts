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
 * Add-on sync lives in Settings › Sync. One line under the heading, before
 * the list, keeps it in view however long the list grows: the way there at
 * the left, the vault's state at the right, under the Import button. Not a
 * row: it is not an add-on and must not read like one. Its state comes from
 * addonVaultControls. A shell without that page keeps the vault controls on
 * this page instead.
 */
function addonSyncNote(): HTMLElement[] {
  if (!document.querySelector("#sync_page_addons")) return []
  const note = document.createElement("div")
  note.className = "addon_sync_note"
  note.dataset.addonSyncLink = ""
  const link = document.createElement("button")
  link.type = "button"
  link.className = "settings_inline_link"
  link.dataset.testid = "open-addon-sync"
  link.textContent = "Add-on sync settings"
  // Already in Settings: switch section, without the menu button that toggles the panel.
  link.addEventListener("click", () => {
    document.querySelector<HTMLButtonElement>("[data-settings-target=\"sync\"]")?.click()
    document.dispatchEvent(new CustomEvent<SyncPage>(SYNC_PAGE_EVENT, { detail: "addons" }))
  })
  const status = document.createElement("span")
  const state = document.createElement("span")
  state.className = "addon_sync_link_state"
  state.dataset.addonSyncSummary = ""
  status.append("Sync status: ", state)
  note.append(link, status)
  return [note]
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
  const empty = document.createElement("p")
  empty.className = "settings_group_hint addon_list_empty"
  empty.textContent = "Add-ons add new features to Once. None are installed yet: import a ZIP, choose a folder, or use a manifest URL to get started."
  // Rarely needed, so a quiet link after the list rather than a button beside it.
  const advancedLink = action("Edit add-on JSON (advanced)", "open-addon-advanced", () => navigate("advanced"))
  advancedLink.className = "settings_inline_link"
  const advancedLine = document.createElement("p")
  advancedLine.className = "addon_advanced_action"
  advancedLine.append(advancedLink)
  overview.append(header, ...addonSyncNote(), updates, empty, list, advancedLine)

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
