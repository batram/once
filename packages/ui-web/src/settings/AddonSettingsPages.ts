import { addonPageAction, createAddonSettingsLayout } from "./addonSettingsLayout"
import { requireClosestElement, requireElement } from "../dom"

const groupsOf = (details: HTMLElement) => Array.from(details.querySelectorAll<HTMLElement>("[data-addon-id], .addon_options_group[data-addon]"))
const idOf = (element: HTMLElement) => element.dataset.addonId ?? element.dataset.addon ?? ""
const titleOf = (element: HTMLElement) => element.dataset.addonName ??
  element.querySelector("legend")?.textContent?.replace(/ settings.*$/, "") ?? idOf(element)

/** Navigation keeps the real controls mounted, including their drafts and listeners. */
export function bindAddonSettingsPages(root: HTMLElement): void {
  if (root.dataset.addonPages) return
  root.dataset.addonPages = "true"
  const { overview, imports, details, advanced, importButton, update, list, count, empty, notice } =
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
    back.textContent = current === "overview" ? "Settings" : "Once Add-ons"
    title.textContent = current === "overview" ? "Once Add-ons" : current === "import" ? "Import addon" :
      current === "advanced" ? "Advanced addons" : rows.get(current)?.dataset.addonName ?? "Addon settings"
  }
  const show = (target: string, focus = true) => {
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
      const meta = [group.dataset.addonVersion, local ? "Local directory · This device" : group.dataset.addonOrigin ?? "Installed",
        !enabled ? "Disabled" : runtime || "Enabled"].filter(Boolean).join(" · ")
      let row = rows.get(key)
      if (!row) {
        row = addonPageAction("", "open-addon-settings", () => show(key))
        row.className = "addon_list_row"
        row.dataset.addonId = id
        const nameElement = document.createElement("strong")
        const description = document.createElement("span")
        description.className = "addon_list_description"
        const metadata = document.createElement("span")
        metadata.className = "addon_list_meta"
        const arrow = document.createElement("span")
        arrow.className = "addon_list_arrow"
        arrow.textContent = "›"
        arrow.setAttribute("aria-hidden", "true")
        row.append(nameElement, description, metadata, arrow)
        rows.set(key, row)
        list.append(row)
      }
      row.dataset.addonName = name
      row.setAttribute("aria-label", `Open ${name} settings`)
      row.children[0].textContent = name
      row.children[1].textContent = group.dataset.addonDescription ?? ""
      row.children[2].textContent = meta
    }
    count.textContent = `Your addons (${addons.size})`
    empty.hidden = addons.size > 0
    if (current.startsWith("addon:") && !rows.has(current)) show("overview")
    setHeader()
  }
  // Status updates touch existing rows; they never replace the settings forms.
  new MutationObserver(sync).observe(details, {
    childList: true, subtree: true, characterData: true, attributes: true,
    attributeFilter: ["data-enabled", "data-addon-name", "data-addon-version"]
  })
  back.addEventListener("click", event => {
    if (!active() || current === "overview") return
    event.stopImmediatePropagation()
    show("overview")
  }, true)
  root.addEventListener("keydown", event => {
    if (event.key !== "Escape" || current === "overview" ||
        (event.target instanceof Element && event.target.matches("input,textarea,select"))) return
    event.stopPropagation()
    show("overview")
  })
  let wasActive = false
  new MutationObserver(() => {
    const isActive = active()
    if (isActive === wasActive) return
    wasActive = isActive
    if (!isActive) { show("overview", false); back.textContent = "Settings" }
    else setHeader()
  }).observe(header, { attributes: true, subtree: true, attributeFilter: ["class"] })
  update.addEventListener("click", () => show("import"))
  root.addEventListener("once:addon-review", () => show("import"))
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
  show("overview", false)
}
