import { BrowserWindow, Rectangle } from "electron"
import { ElectronRect } from "@once/platform-electron/bridge"
import { BrowserMenuState } from "../menus/browserMenuTypes"
import { menuBackground } from "./themeBackground"
import { showWithoutFlash } from "./windowCloak"

declare const BROWSER_MENU_WEBPACK_ENTRY: string
declare const BROWSER_MENU_PRELOAD_WEBPACK_ENTRY: string

const WIDTH = 240
// The menu body's padding and border, so the flyout's first row lines up with the row it opened from.
const INSET = 5

/**
 * The menu's side of the device submenu: opens it at the row the menu asks
 * for, at most one at a time, and tells the menu once it has closed.
 */
export function handleDeviceFlyout(
  panel: BrowserWindow,
  area: Rectangle,
  state: () => BrowserMenuState,
  send: (deviceId: string) => void
): { current(): BrowserWindow | null; close(): void } {
  let flyout: BrowserWindow | null = null
  const close = () => { if (flyout && !flyout.isDestroyed()) flyout.close() }
  panel.webContents.ipc.handle("browser-menu:open-devices", (_event, row: ElectronRect, focus: unknown) => {
    if (flyout && !flyout.isDestroyed()) { if (focus === true) flyout.focus(); return }
    if (!state().devices.length || ![row?.x, row?.y, row?.width, row?.height].every(Number.isFinite)) return
    flyout = openDeviceFlyout({
      panel, area, row, focus: focus === true, state, send,
      closed: () => {
        flyout = null
        if (!panel.isDestroyed()) panel.webContents.send("browser-menu:devices-closed")
      }
    })
  })
  panel.webContents.ipc.handle("browser-menu:close-devices", close)
  return { current: () => flyout, close }
}

/**
 * The browser menu's "Send tab to device" submenu: a second popup beside the
 * menu, served by the same page. It opens to the right of the menu and flips
 * to the left where the screen ends.
 *
 * Opened by hover without taking focus, so the menu keeps the keyboard; opened
 * by keyboard with it. Either way the menu treats focus moving between the two
 * as staying inside the menu.
 */
export function openDeviceFlyout(options: {
  panel: BrowserWindow
  area: Rectangle
  /** The row it opens from, in the menu's content coordinates. */
  row: ElectronRect
  focus: boolean
  state(): BrowserMenuState
  send(deviceId: string): void
  closed(): void
}): BrowserWindow {
  const { panel, area, row } = options
  const flyout = new BrowserWindow({
    parent: panel, width: WIDTH, height: 80,
    frame: false, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, show: false,
    backgroundColor: menuBackground(),
    webPreferences: {
      preload: BROWSER_MENU_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true, sandbox: true, nodeIntegration: false
    }
  })
  const close = () => { if (!flyout.isDestroyed()) flyout.close() }
  flyout.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  flyout.webContents.on("will-navigate", (event) => event.preventDefault())
  flyout.webContents.ipc.handle("browser-menu:state", options.state)
  flyout.webContents.ipc.handle("browser-menu:ready", (_event, height: number) => {
    if (flyout.isDestroyed() || panel.isDestroyed() || !Number.isFinite(height)) return
    const menu = panel.getContentBounds()
    const fitted = Math.min(Math.max(32, Math.ceil(height)), area.height)
    const right = menu.x + menu.width - 2
    const x = right + WIDTH <= area.x + area.width ? right : Math.max(area.x, menu.x - WIDTH + 2)
    const y = Math.max(area.y, Math.min(Math.round(menu.y + row.y) - INSET, area.y + area.height - fitted))
    flyout.setContentBounds({ x, y, width: WIDTH, height: fitted })
    if (options.focus) {
      showWithoutFlash(flyout)
      flyout.focus()
    } else showWithoutFlash(flyout, () => flyout.showInactive())
  })
  flyout.webContents.ipc.handle("browser-menu:send", (_event, deviceId: unknown) => {
    if (!options.state().devices.some((device) => device.deviceId === deviceId)) throw new Error("Unknown device")
    options.send(deviceId as string)
  })
  flyout.webContents.ipc.handle("browser-menu:close-devices", () => {
    // Back to the row it came from, as Left or Escape leave a submenu.
    if (!panel.isDestroyed()) panel.focus()
    close()
  })
  flyout.on("blur", () => setImmediate(() => {
    const focused = BrowserWindow.getFocusedWindow()
    // Focus leaving both popups closes the whole menu; the menu sees to itself.
    if (focused !== panel && focused !== flyout && !panel.isDestroyed()) panel.close()
  }))
  flyout.once("closed", options.closed)
  void flyout.loadURL(`${BROWSER_MENU_WEBPACK_ENTRY}#devices`).catch(close)
  return flyout
}
