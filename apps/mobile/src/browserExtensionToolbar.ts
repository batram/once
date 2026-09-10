import type { InAppBrowserSurface, MobileBrowserExtensions } from "@once/platform-mobile"

const SETTINGS_PREFIX = "once:settings:"

function openExtensionManager(): void {
  document.querySelector<HTMLButtonElement>("#settings_menu_btn")?.click()
  document.querySelector<HTMLButtonElement>('[data-settings-target="extensions"]')?.click()
}

function setStatus(message: string): void {
  const status = document.querySelector<HTMLElement>("#reading_url_validation")
  if (!status) return
  status.textContent = message
  status.hidden = message === ""
}

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
    setStatus("")
    try {
      const result = await api.command({ action: "list" })
      const items = (result.extensions ?? []).filter(item => item.enabled && (item.hasAction || item.hasOptions))
        .map(item => ({
          id: item.id, label: item.name, enabled: true, iconDataUrl: item.iconDataUrl,
          settingsId: item.hasOptions && item.hasAction ? SETTINGS_PREFIX + item.id : undefined
        }))
      items.push({ id: "once:manage", label: "Manage extensions", enabled: true, iconDataUrl: undefined, settingsId: undefined })
      const selected = await surface.showMenu({ items, browserControls: true })
      if (selected === "once:manage") {
        openExtensionManager()
      } else if (selected?.startsWith(SETTINGS_PREFIX)) {
        await api.command({ action: "options", id: selected.slice(SETTINGS_PREFIX.length) })
      } else if (selected) {
        const extension = result.extensions?.find(item => item.id === selected)
        // Without an open page the action falls back to the extension's own
        // settings; an extension without any lands in the manager instead.
        const outcome = await api.command({ action: extension?.hasAction ? "action" : "options", id: selected })
        if (outcome.noPage) openExtensionManager()
      }
    } catch (error) {
      setStatus(`Could not open browser menu: ${error instanceof Error ? error.message : String(error)}`)
    } finally { button.disabled = false; button.setAttribute("aria-expanded", "false") }
  }
}
