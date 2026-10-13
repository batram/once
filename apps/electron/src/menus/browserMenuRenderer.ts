import { BrowserMenuAction, BrowserMenuBridge, BrowserMenuState } from "./browserMenuTypes"
import "./browserMenu.css"

declare global {
  interface Window { onceBrowserMenu: BrowserMenuBridge }
}

const bridge = window.onceBrowserMenu
function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing browser menu element: ${id}`)
  return element as T
}
const errorLabel = required("error")
// How long the pointer rests on a row before its submenu opens or another closes it.
const HOVER_MS = 250

function showError(error: unknown): void {
  errorLabel.hidden = false
  errorLabel.textContent = error instanceof Error ? error.message : String(error)
}

const fit = () => bridge.ready(Math.ceil(document.body.getBoundingClientRect().height))

/** Up and Down move through the visible, enabled buttons, wrapping at the ends. */
function moveFocus(event: KeyboardEvent, keys: { next: string[]; previous: string[] }): boolean {
  const step = keys.next.includes(event.key) ? 1 : keys.previous.includes(event.key) ? -1 : 0
  if (!step) return false
  event.preventDefault()
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"))
    .filter((button) => button.offsetParent !== null)
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  buttons[(current + step + buttons.length) % buttons.length]?.focus()
  return true
}

function showMenu(): void {
  const zoomValue = required<HTMLButtonElement>("zoom-value")
  const sendTab = required<HTMLButtonElement>("send-tab")
  let devicesOpen = false
  let hoverTimer: number | undefined

  const setExpanded = (open: boolean) => {
    devicesOpen = open
    sendTab.setAttribute("aria-expanded", String(open))
  }
  const openDevices = (focus: boolean) => {
    clearTimeout(hoverTimer)
    const row = sendTab.getBoundingClientRect()
    setExpanded(true)
    void bridge.openDevices({ x: row.left, y: row.top, width: row.width, height: row.height }, focus).catch(showError)
  }
  const closeDevices = () => {
    clearTimeout(hoverTimer)
    if (devicesOpen) void bridge.closeDevices().catch(showError)
  }

  function render(state: BrowserMenuState): void {
    for (const kbd of document.querySelectorAll<HTMLElement>("kbd[data-shortcut]")) {
      kbd.textContent = state.shortcuts[kbd.dataset.shortcut as keyof BrowserMenuState["shortcuts"]] ?? ""
    }
    const noTab = state.zoom === null
    for (const action of ["zoom-in", "zoom-out", "zoom-reset", "close-tab"]) {
      const button = document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
      if (button) button.disabled = noTab
    }
    zoomValue.textContent = `${Math.round((state.zoom ?? 1) * 100)}%`
    const fullscreen = required<HTMLButtonElement>("fullscreen")
    fullscreen.setAttribute("aria-pressed", String(state.fullscreen))
    const label = state.fullscreen ? "Exit full screen" : "Full screen"
    fullscreen.setAttribute("aria-label", label)
    fullscreen.title = state.shortcuts.fullscreen ? `${label} (${state.shortcuts.fullscreen})` : label
    required("clear-site").hidden = !state.site
    required("site-divider").hidden = !state.site
    required("clear-site-label").textContent = state.site ? `Clear data for ${state.site}…` : ""
    sendTab.hidden = !state.devices.length
    if (!state.devices.length) closeDevices()
  }

  async function act(action: BrowserMenuAction): Promise<void> {
    try {
      render(await bridge.action(action))
    } catch (error) {
      showError(error)
    }
  }

  for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
    button.onclick = () => void act(button.dataset.action as BrowserMenuAction)
  }
  // The submenu opens when the pointer rests on its row, and closes when it
  // rests on another; moving across to the submenu itself leaves it open.
  sendTab.addEventListener("mouseenter", () => {
    clearTimeout(hoverTimer)
    hoverTimer = window.setTimeout(() => openDevices(false), HOVER_MS)
  })
  sendTab.addEventListener("mouseleave", () => clearTimeout(hoverTimer))
  for (const row of document.querySelectorAll<HTMLElement>("#menu > :not(#send-tab)")) {
    row.addEventListener("mouseenter", () => {
      clearTimeout(hoverTimer)
      if (devicesOpen) hoverTimer = window.setTimeout(closeDevices, HOVER_MS)
    })
  }
  // A click opens it at once; from the keyboard (Enter, Space) it takes focus too.
  sendTab.onclick = (event) => openDevices(event.detail === 0)
  bridge.onDevicesClosed(() => setExpanded(false))
  bridge.onStateChanged(render)
  // The menu holds the keyboard while open, so the zoom keys act on the tab from here.
  const ZOOM_KEYS: Record<string, BrowserMenuAction> = { "+": "zoom-in", "=": "zoom-in", "-": "zoom-out", "0": "zoom-reset" }
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); void act("close"); return }
    const zoom = (event.ctrlKey || event.metaKey) && !event.altKey ? ZOOM_KEYS[event.key] : undefined
    if (zoom) { event.preventDefault(); void act(zoom); return }
    if (event.key === "ArrowRight" && document.activeElement === sendTab) {
      event.preventDefault()
      openDevices(true)
      return
    }
    if (moveFocus(event, { next: ["ArrowDown", "ArrowRight"], previous: ["ArrowUp", "ArrowLeft"] })) closeDevices()
  })
  void bridge.state().then(async (state) => {
    render(state)
    document.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus()
    await fit()
  }).catch(showError)
}

/** The device submenu, in its own popup beside the menu. */
function showDevices(): void {
  required("menu").hidden = true
  const list = required("devices")
  list.hidden = false
  const close = () => void bridge.closeDevices().catch(showError)
  document.addEventListener("keydown", (event) => {
    // Left and Escape go back to the menu, as they leave a native submenu.
    if (event.key === "Escape" || event.key === "ArrowLeft") { event.preventDefault(); close(); return }
    moveFocus(event, { next: ["ArrowDown"], previous: ["ArrowUp"] })
  })
  // Opened by hover it shows without focus; once it has focus, the first device does.
  window.addEventListener("focus", () => {
    if (!(document.activeElement instanceof HTMLButtonElement)) list.querySelector<HTMLButtonElement>("button")?.focus()
  })
  void bridge.state().then(async (state) => {
    if (!state.devices.length) { close(); return }
    list.replaceChildren(...state.devices.map((device) => {
      const button = document.createElement("button")
      button.type = "button"
      button.setAttribute("role", "menuitem")
      button.dataset.device = device.deviceId
      button.title = device.name
      const label = document.createElement("span")
      label.textContent = device.name
      button.append(label)
      button.onclick = () => void bridge.send(device.deviceId).catch(showError)
      return button
    }))
    if (document.hasFocus()) list.querySelector<HTMLButtonElement>("button")?.focus()
    await fit()
  }).catch(showError)
}

if (location.hash === "#devices") showDevices()
else showMenu()
