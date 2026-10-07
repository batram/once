import { addonPageAction, createAddonSettingsLayout } from "./addonSettingsLayout"
import { requireClosestElement, requireElement } from "../dom"
import { refreshAddonCollectionSummary } from "./addonAvailability"
import { invalidateSettingsPages, openSettingsPage, registerSettingsOverview } from "./SettingsNavigation"

const groupsOf = (details: HTMLElement) => Array.from(details.querySelectorAll<HTMLElement>("[data-addon-id], .addon_options_group[data-addon]"))
const idOf = (element: HTMLElement) => element.dataset.addonId ?? element.dataset.addon ?? ""
/** The settings group knows about a linked folder; the installed row does not, so the later element speaks. */
const originOf = (elements: HTMLElement[]) => [...elements].reverse().map(element => element.dataset.addonOrigin).find(Boolean)
const titleOf = (element: HTMLElement) => element.dataset.addonName ??
  element.querySelector("legend")?.textContent?.replace(/ settings.*$/, "") ?? idOf(element)

function describeCollection(root: HTMLElement, count: HTMLElement, empty: HTMLElement, size: number): void {
  const paused = ["locked", "conflict", "error"].includes(root.dataset.vaultState ?? "")
  count.textContent = paused ? `Available on this device (${size})` : `Your add-ons (${size})`
  empty.hidden = size > 0 || paused
  refreshAddonCollectionSummary()
}

/** An add-on's row on the overview: name, description and status line, filled in by the caller. */
function listRow(id: string, open: () => void): HTMLButtonElement {
  const row = addonPageAction("", "open-addon-settings", open)
  row.className = "addon_list_row"
  row.dataset.addonId = id
  const name = document.createElement("strong")
  const description = document.createElement("span")
  description.className = "addon_list_description"
  const metadata = document.createElement("span")
  metadata.className = "addon_list_meta"
  const arrow = document.createElement("span")
  arrow.className = "addon_list_arrow"
  arrow.textContent = "›"
  arrow.setAttribute("aria-hidden", "true")
  row.append(name, description, metadata, arrow)
  return row
}

/** Navigation keeps the real controls mounted, including their drafts and listeners. */
export function bindAddonSettingsPages(root: HTMLElement): void {
  if (root.dataset.addonPages) return
  root.dataset.addonPages = "true"
  const { overview, imports, details, advanced, importButton, list, count, empty, notice } =
    createAddonSettingsLayout(root, target => show(target))
  let current = "overview"
  let returnFocus: HTMLElement = importButton
  const rows = new Map<string, HTMLButtonElement>()
  const header = requireClosestElement(root, "#settings_panel")
  const back = requireElement<HTMLButtonElement>("#settings_section_back", header)
  const title = requireElement<HTMLElement>(".settings_title", header)
  const active = () => root.closest(".settings_section")?.classList.contains("active") === true
  const setHeader = () => {
    if (!active()) return
    title.textContent = current === "overview" ? "Once Add-ons" : current === "import" ? "Import add-on" :
      current === "advanced" ? "Advanced add-ons" : rows.get(current)?.dataset.addonName ?? "Add-on settings"
  }
  const show = (target: string, focus = true) => openSettingsPage(root, {
    key: target,
    title: () => target === "overview" ? "Once Add-ons" : target === "import" ? "Import add-on" :
      target === "advanced" ? "Advanced add-ons" : rows.get(target)?.dataset.addonName ?? "Add-on settings",
    show: () => render(target, focus),
    valid: () => !target.startsWith("addon:") || rows.has(target)
  })
  const render = (target: string, focus = true) => {
    if (current === "overview" && target !== current) {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : importButton
    }
    current = target
    overview.hidden = target !== "overview"
    imports.hidden = target !== "import"
    advanced.hidden = target !== "advanced"
    details.hidden = ["overview", "import", "advanced"].includes(target)
    for (const group of groupsOf(details)) group.hidden = `addon:${idOf(group)}` !== target
    setHeader()
    root.scrollTop = 0
    if (focus) {
      const destination = target === "overview" ? (returnFocus.isConnected ? returnFocus : importButton) : back
      destination.focus({ preventScroll: true })
    }
  }
  const sync = () => {
    const addons = new Map<string, HTMLElement[]>()
    for (const group of groupsOf(details)) {
      const id = idOf(group)
      addons.set(id, [...addons.get(id) ?? [], group])
      group.hidden = current !== `addon:${id}`
    }
    for (const [key, row] of rows) if (!addons.has(key.slice(6))) { row.remove(); rows.delete(key) }
    for (const [id, elements] of addons) {
      const key = `addon:${id}`
      const group = elements[0]
      const name = titleOf(group)
      const local = !group.dataset.addonId
      const enabled = group.dataset.enabled !== "false"
      const runtime = group.querySelector(".addon_runtime_status")?.textContent
      const meta = [group.dataset.addonVersion, originOf(elements) ?? (local ? "Linked folder · this device" : "Imported copy"),
        !enabled ? "Disabled" : runtime || "Enabled"].filter(Boolean).join(" · ")
      let row = rows.get(key)
      if (!row) {
        row = listRow(id, () => show(key))
        rows.set(key, row)
        list.append(row)
      }
      row.dataset.addonName = name
      row.setAttribute("aria-label", `Open ${name} settings`)
      row.children[0].textContent = name
      row.children[1].textContent = group.dataset.addonDescription ?? ""
      row.children[2].textContent = meta
    }
    // The Add-on sync row stays last, after add-ons installed since.
    const syncLink = list.querySelector(":scope > .addon_sync_link")
    if (syncLink && syncLink !== list.lastElementChild) list.append(syncLink)
    describeCollection(root, count, empty, addons.size)
    invalidateSettingsPages()
    if (current.startsWith("addon:") && !rows.has(current)) render("overview")
    setHeader()
  }
  // Status updates touch existing rows; they never replace the settings forms.
  new MutationObserver(sync).observe(details, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ["data-enabled", "data-addon-name", "data-addon-version"]
  })
  new MutationObserver(sync).observe(root, { attributes: true, attributeFilter: ["data-vault-state"] })
  let wasActive = false
  new MutationObserver(() => {
    const isActive = active()
    if (isActive === wasActive) return
    wasActive = isActive
    if (isActive) setHeader()
  }).observe(header, { attributes: true, subtree: true, attributeFilter: ["class"] })
  // A review shows where it was asked for: an import's on the Import page,
  // an update's on the overview above the list (even when asked from an
  // add-on's own page).
  root.addEventListener("once:addon-review", event => show(imports.contains(event.target as globalThis.Node | null) ? "import" : "overview"))
  root.addEventListener("once:addon-installed", event => {
    notice.textContent = (event as CustomEvent<string>).detail
    show("overview")
  })
  // Search results can point into a page that is currently hidden.
  root.addEventListener("once:addon-reveal", event => {
    const target = (event as CustomEvent<HTMLElement>).detail
    const group = target.closest<HTMLElement>(".addon_options_group, [data-addon-id]")
    show(group ? `addon:${idOf(group)}` : advanced.contains(target) ? "advanced" : "import", false)
  })
  sync()
  registerSettingsOverview(root, () => render("overview", false))
  render("overview", false)
}
