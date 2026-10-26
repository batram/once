import { BrowserWindow, ipcMain, screen, WebContents } from "electron"
import { ELECTRON_IPC, ElectronRect } from "@once/platform-electron/bridge"
import { siteForUrl } from "@once/app/browsingSite"
import { BrowserCoordinator } from "../TabManager"
import { WindowEntry } from "./BrowserState"
import { confirmClearSiteData } from "./BrowsingData"
import { BrowserMenuAction, BrowserMenuCommand, BrowserMenuState } from "../menus/browserMenuTypes"
import { sourceUrlFromReaderUrl } from "./reader-url"
import { applyZoomStep, shellRect } from "./Zoom"
import { handleDeviceFlyout } from "./BrowserMenuFlyout"
import { menuBackground } from "./themeBackground"
import { showWithoutFlash } from "./windowCloak"

declare const BROWSER_MENU_WEBPACK_ENTRY: string
declare const BROWSER_MENU_PRELOAD_WEBPACK_ENTRY: string

const WIDTH = 300
const COMMANDS: readonly BrowserMenuCommand[] = ["new-tab", "new-window", "close-tab", "fullscreen", "history"]
const openMenus = new WeakMap<BrowserWindow, BrowserWindow>()
// Pressing the button while the menu is open blurs the menu first, which
// closes it before the click arrives; that click must not open it again.
const closedAt = new WeakMap<BrowserWindow, number>()
const TOGGLE_GRACE_MS = 300

/**
 * The burger menu at the end of the address bar: tab and window commands, the
 * active tab's zoom, and its site's data. An owned window rather than a native
 * menu, so the zoom row can hold buttons that act without closing it.
 *
 * Resolves with the command the shell should run, or null. Commands go back to
 * the shell because it owns them, along with their keybindings.
 */
export function showBrowserMenu(
  owner: WindowEntry,
  anchor: ElectronRect,
  shortcuts: BrowserMenuState["shortcuts"],
  activeTab: () => WebContents | null,
  sending: { targets(): BrowserMenuState["devices"]; send(deviceId: string): void }
): Promise<BrowserMenuCommand | null> {
  const window = owner.window
  const previous = openMenus.get(window)
  if (previous && !previous.isDestroyed()) {
    // A second click on the button closes the menu, as menus do.
    previous.close()
    return Promise.resolve(null)
  }
  if (Date.now() - (closedAt.get(window) ?? 0) < TOGGLE_GRACE_MS) return Promise.resolve(null)
  const origin = window.getContentBounds()
  const right = Math.round(origin.x + anchor.x + anchor.width)
  const top = Math.round(origin.y + anchor.y + anchor.height + 4)
  const area = screen.getDisplayNearestPoint({ x: right, y: top }).workArea
  const panel = new BrowserWindow({
    parent: window, width: WIDTH, height: 240,
    x: Math.max(area.x, Math.min(right - WIDTH, area.x + area.width - WIDTH)),
    y: Math.max(area.y, top),
    frame: false, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, show: false,
    backgroundColor: menuBackground(),
    webPreferences: {
      preload: BROWSER_MENU_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true, sandbox: true, nodeIntegration: false
    }
  })
  openMenus.set(window, panel)
  let result: BrowserMenuCommand | null = null

  const state = (): BrowserMenuState => {
    const tab = activeTab()
    const url = tab?.getURL() ?? ""
    const site = tab ? siteForUrl(sourceUrlFromReaderUrl(url) ?? url) : null
    return {
      zoom: tab ? tab.getZoomFactor() : null,
      site,
      fullscreen: window.isFullScreen(),
      devices: site ? sending.targets() : [],
      shortcuts
    }
  }
  const finish = () => {
    // Activate the owner before closing: an active owned window that closes
    // leaves activation to the system, and the shell ignores the keyboard
    // until it arrives (see ExtensionMenu).
    setImmediate(() => { if (!panel.isDestroyed()) { window.focus(); panel.close() } })
  }
  panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  panel.webContents.on("will-navigate", (event) => event.preventDefault())
  panel.webContents.ipc.handle("browser-menu:state", state)
  panel.webContents.ipc.handle("browser-menu:ready", (_event, height: number) => {
    if (panel.isDestroyed() || !Number.isFinite(height)) return
    const fitted = Math.min(Math.max(80, Math.ceil(height)), area.y + area.height - panel.getBounds().y)
    panel.setContentSize(WIDTH, fitted)
    showWithoutFlash(panel)
  })
  const devices = handleDeviceFlyout(panel, area, state, (deviceId) => { finish(); sending.send(deviceId) })
  panel.webContents.ipc.handle("browser-menu:action", (_event, action: BrowserMenuAction) => {
    const tab = activeTab()
    if (action === "zoom-in" || action === "zoom-out" || action === "zoom-reset") {
      if (tab) applyZoomStep(tab, action === "zoom-in" ? "in" : action === "zoom-out" ? "out" : "reset")
      return state()
    }
    if (action === "clear-site") {
      const site = state().site
      finish()
      if (site) void confirmClearSiteData(window, site)
      return state()
    }
    if ((COMMANDS as readonly string[]).includes(action)) result = action as BrowserMenuCommand
    else if (action !== "close") throw new Error("Unknown browser menu action")
    finish()
    return state()
  })
  const close = () => { if (!panel.isDestroyed()) panel.close() }
  // Ctrl+wheel over the page still zooms it while the menu is open; the zoom
  // row follows. Sent on the next turn, after Zoom.ts has applied the step.
  const tab = activeTab()
  const zoomed = () => setImmediate(() => {
    if (!panel.isDestroyed()) panel.webContents.send("browser-menu:state-changed", state())
  })
  tab?.on("zoom-changed", zoomed)
  // Focus moving into the device submenu stays inside the menu.
  panel.on("blur", () => setImmediate(() => {
    const flyout = devices.current()
    if (!flyout || BrowserWindow.getFocusedWindow() !== flyout) close()
  }))
  window.on("move", close)
  window.on("resize", close)
  window.on("closed", close)
  return new Promise((resolve, reject) => {
    panel.once("closed", () => {
      if (openMenus.get(window) === panel) openMenus.delete(window)
      closedAt.set(window, Date.now())
      devices.close()
      window.removeListener("move", close)
      window.removeListener("resize", close)
      window.removeListener("closed", close)
      if (tab && !tab.isDestroyed()) tab.removeListener("zoom-changed", zoomed)
      resolve(result)
    })
    void panel.loadURL(BROWSER_MENU_WEBPACK_ENTRY).then(() => {
      // Normally shown once the page has measured itself; never left invisible.
      setTimeout(() => { if (!panel.isDestroyed() && !panel.isVisible()) showWithoutFlash(panel) }, 500)
    }).catch((error) => { reject(error); close() })
  })
}

function readShortcuts(value: unknown): BrowserMenuState["shortcuts"] {
  const shortcuts: BrowserMenuState["shortcuts"] = {}
  if (!value || typeof value !== "object") return shortcuts
  for (const command of COMMANDS) {
    const chord = (value as Record<string, unknown>)[command]
    if (typeof chord === "string" && chord.length <= 40) shortcuts[command] = chord
  }
  return shortcuts
}

export function registerBrowserMenuHandlers(coordinator: BrowserCoordinator): void {
  ipcMain.handle(ELECTRON_IPC.windowShowBrowserMenu, (event, anchor: ElectronRect, shortcuts: unknown) => {
    const owner = coordinator.requireWindow(event)
    const rect = shellRect(event.sender, anchor)
    if (!rect || ![rect.x, rect.y, rect.width, rect.height].every(Number.isFinite)) {
      throw new Error("Invalid browser menu anchor")
    }
    const activeTab = () => {
      try { return owner.activeId ? coordinator.tabContents(owner, owner.activeId) : null } catch { return null }
    }
    // The tab active when the menu opened, so a device picked later sends that one.
    const tabId = owner.activeId
    return showBrowserMenu(owner, rect, readShortcuts(shortcuts), activeTab, {
      targets: () => tabId ? coordinator.menus.sendTargets : [],
      // The shell sends it, as for the tab strip's "Send Tab to Device".
      send: (deviceId) => { if (tabId && !owner.window.isDestroyed()) owner.window.webContents.send(ELECTRON_IPC.tabSyncSendTab, tabId, deviceId) }
    })
  })
}
