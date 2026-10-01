import { ElectronBridge, ElectronExtensionInfo, ElectronToolbarTool } from "@once/platform-electron/bridge"

const PINNED_KEY = "once-electron-pinned-extensions"
/** Shell tools start pinned, so the stored list names the ones taken off. */
const HIDDEN_TOOLS_KEY = "once-electron-hidden-toolbar-tools"
/** Fired on `document` when any pin changes; shell buttons re-read theirs. */
export const TOOLBAR_PINS_CHANGED = "once-toolbar-pins-changed"

function readList(key: string): string[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) || "[]")
    return Array.isArray(value) ? value.filter((host): host is string => typeof host === "string") : []
  } catch {
    return []
  }
}

function writeLists(pinned: string[], hidden: string[]): void {
  localStorage.setItem(PINNED_KEY, JSON.stringify(pinned))
  localStorage.setItem(HIDDEN_TOOLS_KEY, JSON.stringify(hidden))
  document.dispatchEvent(new Event(TOOLBAR_PINS_CHANGED))
}

export function isToolPinned(id: string): boolean {
  return !readList(HIDDEN_TOOLS_KEY).includes(id)
}

export function unpinTool(id: string): void {
  writeLists(readList(PINNED_KEY), [...new Set([...readList(HIDDEN_TOOLS_KEY), id])])
}

/**
 * The context menu every pinnable toolbar button shares: the shell's native
 * menu keeps "Inspect" and adds the only pin action a button can take, since
 * pinning happens in the extensions panel.
 */
export function bindUnpinMenu(bridge: ElectronBridge, button: HTMLElement, name: string, unpin: () => void): void {
  button.oncontextmenu = (event) => {
    event.preventDefault()
    void bridge.storyMenu.show([
      { id: "inspect", label: "Inspect", group: "inspect", enabled: true, visible: true },
      { id: "unpin", label: `Unpin ${name}`, group: "pin", enabled: true, visible: true }
    ], { x: event.clientX, y: event.clientY }).then(selected => {
      if (selected === "unpin") unpin()
    }).catch(error => console.error("Failed to show toolbar button menu", error))
  }
}

const iconData = new Map<string, Promise<string | null>>()

/**
 * A shell icon as a data URL, for the extensions panel, which has no access
 * to the shell's stylesheet: the icon classes paint a masked SVG, so the
 * computed mask names the file to fetch.
 */
export function shellIconData(icon: string): Promise<string | null> {
  let pending = iconData.get(icon)
  if (!pending) {
    pending = (async () => {
      const probe = document.createElement("span")
      probe.className = `icon icon--chrome icon--${icon}`
      probe.hidden = true
      document.body.append(probe)
      const style = getComputedStyle(probe)
      const source = (style.maskImage || style.webkitMaskImage || "").match(/url\("?([^")]+)"?\)/)?.[1]
      probe.remove()
      if (!source) return null
      const response = await fetch(source)
      if (!response.ok) return null
      return `data:image/svg+xml;utf8,${encodeURIComponent(await response.text())}`
    })().catch(() => null)
    iconData.set(icon, pending)
  }
  return pending
}

function actionButton(bridge: ElectronBridge, info: ElectronExtensionInfo, unpin: () => void): HTMLButtonElement {
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
  bindUnpinMenu(bridge, button, info.name, unpin)
  return button
}

/** What the shell lends the extensions menu: its own pinnable buttons. */
export interface ToolbarShell {
  openSettings(): void
  tools(): Promise<ElectronToolbarTool[]>
  runTool(id: string): void
}

/** Native menus remain above the browser's WebContentsView. */
export function bindExtensionToolbar(bridge: ElectronBridge, container: HTMLElement, shell: ToolbarShell): void {
  let infos: ElectronExtensionInfo[] = []
  let revision = 0
  // The tools the menu was last shown with; its pin reports name them too.
  let menuTools: ElectronToolbarTool[] = []
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
    const pinned = new Set(readList(PINNED_KEY))
    container.replaceChildren(
      ...infos.filter(info => pinned.has(info.host)).map(info => actionButton(bridge, info, () => {
        writeLists(readList(PINNED_KEY).filter(host => host !== info.host), readList(HIDDEN_TOOLS_KEY))
        paint()
      })),
      menuButton
    )
  }
  /** Splits the menu's one list back into pinned extensions and hidden tools. */
  const applyPins = (pinned: string[]) => {
    const toolIds = new Set(menuTools.map(tool => tool.id))
    const chosen = new Set(pinned)
    const hidden = readList(HIDDEN_TOOLS_KEY).filter(id => !toolIds.has(id))
      .concat(menuTools.map(tool => tool.id).filter(id => !chosen.has(id)))
    writeLists(pinned.filter(id => !toolIds.has(id)), hidden)
    paint()
  }
  menuButton.onclick = async () => {
    if (menuButton.getAttribute("aria-expanded") === "true") return
    const rect = menuButton.getBoundingClientRect()
    menuButton.setAttribute("aria-expanded", "true")
    try {
      const anchor = { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      menuTools = await shell.tools()
      const pinned = [...readList(PINNED_KEY), ...menuTools.map(tool => tool.id).filter(isToolPinned)]
      const result = await bridge.extensions.showMenu(anchor, pinned, menuTools)
      applyPins(result.pinned)
      if (result.host) await bridge.extensions.openPopup(result.host, anchor)
      else if (result.tool) {
        await bridge.window.focusShell()
        shell.runTool(result.tool)
      } else if (result.settings) {
        await bridge.window.focusShell()
        shell.openSettings()
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
  bridge.extensions.onPinsChanged(applyPins)
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
    if (event.key === PINNED_KEY || event.key === HIDDEN_TOOLS_KEY || event.key === null) {
      paint()
      document.dispatchEvent(new Event(TOOLBAR_PINS_CHANGED))
    }
  })
  paint()
  bridge.extensions.onChanged(render)
  render()
}
