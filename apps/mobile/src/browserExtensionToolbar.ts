import type { InAppBrowserSurface, MobileBrowserExtensions } from "@once/platform-mobile"

/** Browser controls use a native sheet so they remain above GeckoView. */
export function bindMobileExtensionToolbar(api: MobileBrowserExtensions, surface: InAppBrowserSurface): void {
  const navigate = document.querySelector<HTMLButtonElement>("#reading_navigate")
  if (!navigate) return
  const button = document.createElement("button")
  button.type = "button"
  button.id = "reading_browser_menu"
  button.className = "button button--icon"
  button.title = "Browser menu"
  button.setAttribute("aria-label", "Browser menu")
  button.setAttribute("aria-haspopup", "dialog")
  button.setAttribute("aria-expanded", "false")
  button.innerHTML = '<svg width="24" height="24" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><circle cx="12" cy="5" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="12" cy="19" r="2"/></svg>'
  navigate.after(button)
  navigate.parentElement?.classList.add("has-browser-menu")
  button.onclick = async () => {
    button.disabled = true
    button.setAttribute("aria-expanded", "true")
    try {
      const result = await api.command({ action: "list" })
      const items = (result.extensions ?? []).filter(item => item.enabled && (item.hasAction || item.hasOptions))
        .map(item => ({ id: item.id, label: item.name, enabled: true, iconDataUrl: item.iconDataUrl }))
      items.push({ id: "once:manage", label: "Manage extensions", enabled: true, iconDataUrl: undefined })
      const selected = await surface.showMenu({ items, browserControls: true })
      if (selected === "once:manage") {
        document.querySelector<HTMLButtonElement>("#settings_menu_btn")?.click()
        document.querySelector<HTMLButtonElement>('[data-settings-target="extensions"]')?.click()
      } else if (selected) {
        const extension = result.extensions?.find(item => item.id === selected)
        await api.command({ action: extension?.hasAction ? "action" : "options", id: selected })
      }
    } catch (error) {
      const status = document.querySelector<HTMLElement>("#reading_url_validation")
      if (status) { status.textContent = `Could not open browser menu: ${error instanceof Error ? error.message : String(error)}`; status.hidden = false }
    } finally { button.disabled = false; button.setAttribute("aria-expanded", "false") }
  }
}
