import { ElectronBridge, ElectronExtensionInfo } from "@once/platform-electron/bridge"

function actionButton(bridge: ElectronBridge, info: ElectronExtensionInfo): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "browser-button image-button extension-action"
  button.title = info.title + (info.settingsStatus ? ` — Settings ${info.settingsStatus.state}${info.settingsStatus.error ? `: ${info.settingsStatus.error}` : ""}` : "")
  if (info.settingsStatus) button.dataset.settingsStatus = info.settingsStatus.state
  button.setAttribute("aria-label", info.title)
  button.disabled = !info.enabled
  if (info.icon) {
    const icon = document.createElement("img")
    icon.src = info.icon
    icon.alt = ""
    button.append(icon)
  } else {
    button.textContent = info.name.slice(0, 1).toUpperCase()
  }
  if (info.badgeText) {
    const badge = document.createElement("span")
    badge.className = "extension-action__badge"
    badge.textContent = info.badgeText
    // The colour is the extension's own; the sheet reads it through a token.
    if (info.badgeBackgroundColor) {
      badge.style.setProperty("--extension-badge-background", info.badgeBackgroundColor)
    }
    button.append(badge)
  }
  button.onclick = () => {
    const rect = button.getBoundingClientRect()
    void bridge.extensions.openPopup(info.host, {
      x: rect.x, y: rect.y, width: rect.width, height: rect.height
    })
  }
  return button
}

const PINNED_KEY = "once-electron-pinned-extensions"

function readPinned(): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(PINNED_KEY) || "[]")
    return Array.isArray(value) ? value.filter((host): host is string => typeof host === "string") : []
  } catch {
    return []
  }
}

/** Native menus remain above the browser's WebContentsView. */
export function bindExtensionToolbar(bridge: ElectronBridge, container: HTMLElement, openSettings: () => void): void {
  let infos: ElectronExtensionInfo[] = []
  let revision = 0
  const menuButton = document.createElement("button")
  menuButton.type = "button"
  menuButton.className = "browser-button image-button"
  menuButton.title = "Extensions"
  menuButton.setAttribute("aria-label", "Extensions")
  menuButton.setAttribute("aria-haspopup", "dialog")
  menuButton.setAttribute("aria-expanded", "false")
  // A small puzzle piece, sized by the same chrome tokens as adjacent controls.
  menuButton.innerHTML = '<svg width="18" height="18" viewBox="-2 -3 26 26" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" aria-hidden="true"><path d="M9 3H4v6H3a3 3 0 0 0 0 6h1v6h6v-1a3 3 0 0 1 6 0v1h5v-6h-1a3 3 0 0 1 0-6h1V3h-6V2a3 3 0 0 0-6 0Z"/></svg>'
  const paint = () => {
    const pinned = new Set(readPinned())
    container.replaceChildren(...infos.filter(info => pinned.has(info.host)).map(info => actionButton(bridge, info)), menuButton)
  }
  menuButton.onclick = async () => {
    if (menuButton.getAttribute("aria-expanded") === "true") return
    const rect = menuButton.getBoundingClientRect()
    menuButton.setAttribute("aria-expanded", "true")
    try {
      const anchor = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      const result = await bridge.extensions.showMenu(anchor, readPinned())
      localStorage.setItem(PINNED_KEY, JSON.stringify(result.pinned))
      paint()
      if (result.host) await bridge.extensions.openPopup(result.host, anchor)
      else if (result.settings) {
        await bridge.window.focusShell()
        openSettings()
      } else if (result.focusTrigger) {
        await bridge.window.focusShell()
        menuButton.focus()
      }
    } catch (error) {
      console.error("Failed to open extensions menu or save pinned extensions", error)
    } finally {
      menuButton.setAttribute("aria-expanded", "false")
    }
  }
  bridge.extensions.onPinsChanged(pinned => {
    localStorage.setItem(PINNED_KEY, JSON.stringify(pinned))
    paint()
  })
  const render = () => {
    const request = ++revision
    void bridge.extensions.list().then((infos) => {
      if (request !== revision) return
      update(infos)
    }).catch(error => console.error("Failed to load extensions", error))
  }
  const update = (next: ElectronExtensionInfo[]) => {
    infos = next
    paint()
  }
  window.addEventListener("storage", event => {
    if (event.key === PINNED_KEY || event.key === null) paint()
  })
  paint()
  bridge.extensions.onChanged(render)
  render()
}
