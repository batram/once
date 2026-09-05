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

/**
 * One button per loaded extension. The popup itself is a native view the
 * main process lays over the window, so the shell only says where it goes.
 */
export function bindExtensionToolbar(bridge: ElectronBridge, container: HTMLElement): void {
  const render = () => {
    void bridge.extensions.list().then((infos) => {
      container.replaceChildren(...infos.map((info) => actionButton(bridge, info)))
    })
  }
  bridge.extensions.onChanged(render)
  render()
}
