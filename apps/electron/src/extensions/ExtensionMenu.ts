import { BrowserWindow, screen } from "electron"
import { ElectronExtensionInfo, ElectronRect, ElectronToolbarTool } from "@once/platform-electron/bridge"
import { ExtensionMenuResult, ExtensionMenuState } from "./extensionMenuTypes"

declare const EXTENSION_MENU_WEBPACK_ENTRY: string
declare const EXTENSION_MENU_PRELOAD_WEBPACK_ENTRY: string

const openMenus = new WeakMap<BrowserWindow, BrowserWindow>()

/** An owned window keeps the panel above native browser views. */
export function showExtensionMenu(
  owner: BrowserWindow,
  anchor: ElectronRect,
  infos: ElectronExtensionInfo[],
  tools: ElectronToolbarTool[],
  pinned: string[],
  pinsChanged: (pinned: string[]) => void
): Promise<ExtensionMenuResult> {
  const previous = openMenus.get(owner)
  if (previous && !previous.isDestroyed()) {
    previous.close()
    return Promise.resolve({ pinned })
  }
  const origin = owner.getContentBounds()
  const right = Math.round(origin.x + anchor.x + anchor.width)
  const top = Math.round(origin.y + anchor.y + anchor.height + 6)
  const area = screen.getDisplayNearestPoint({ x: right, y: top }).workArea
  const width = Math.min(352, area.width)
  const height = Math.min(480, 128 + (Math.max(1, infos.length) + tools.length) * 48 + (tools.length ? 9 : 0), area.height)
  const panel = new BrowserWindow({
    parent: owner, width, height,
    x: Math.max(area.x, Math.min(right - width, area.x + area.width - width)),
    y: Math.max(area.y, Math.min(top, area.y + area.height - height)),
    frame: false, resizable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, show: false,
    backgroundColor: "#ffffff",
    webPreferences: {
      preload: EXTENSION_MENU_PRELOAD_WEBPACK_ENTRY,
      contextIsolation: true, sandbox: true, nodeIntegration: false
    }
  })
  openMenus.set(owner, panel)
  const selection = new Set(pinned)
  const result: ExtensionMenuResult = { pinned: [...selection] }
  const state = (): ExtensionMenuState => ({ infos, tools, pinned: [...selection] })
  panel.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  panel.webContents.on("will-navigate", event => event.preventDefault())
  panel.webContents.ipc.handle("extension-menu:state", state)
  panel.webContents.ipc.handle("extension-menu:action", (_event, action: string, host?: string) => {
    const info = infos.find(item => item.host === host)
    const tool = tools.find(item => item.id === host)
    const id = info?.host ?? tool?.id
    if (action === "pin" && id) {
      if (selection.has(id)) selection.delete(id)
      else selection.add(id)
      result.pinned = [...selection]
      pinsChanged(result.pinned)
      return state()
    }
    if (action === "open" && info?.enabled) result.host = info.host
    else if (action === "open" && tool?.enabled) result.tool = tool.id
    else if (action === "settings") result.settings = true
    else if (action === "close") result.focusTrigger = true
    else throw new Error("Unknown extension menu action")
    // Finish the invoke before disposing its webContents. The owner is
    // activated first: closing an active owned window leaves handing
    // activation back to the system, and until it does the shell's focused
    // control ignores the keyboard. A blur close skips this, as the user
    // has moved elsewhere.
    setImmediate(() => { if (!panel.isDestroyed()) { owner.focus(); panel.close() } })
    return state()
  })
  const close = () => { if (!panel.isDestroyed()) panel.close() }
  panel.on("blur", () => setImmediate(close))
  owner.on("move", close)
  owner.on("resize", close)
  owner.on("closed", close)
  return new Promise((resolve, reject) => {
    panel.once("closed", () => {
      if (openMenus.get(owner) === panel) openMenus.delete(owner)
      owner.removeListener("move", close)
      owner.removeListener("resize", close)
      owner.removeListener("closed", close)
      resolve(result)
    })
    void panel.loadURL(EXTENSION_MENU_WEBPACK_ENTRY).then(() => {
      if (!panel.isDestroyed()) panel.show()
    }).catch(error => { reject(error); close() })
  })
}
