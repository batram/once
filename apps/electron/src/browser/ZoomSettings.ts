import { BrowserWindow, ipcMain, session, webContents } from "electron"
import { ELECTRON_IPC } from "@once/platform-electron/bridge"
import { BROWSER_SESSION_PARTITION, BrowserCoordinator } from "../TabManager"
import { SecureSettings } from "../SecureSettings"
import { isZoomFactor } from "./Zoom"

// The Appearance settings' zoom rows. Chromium keeps zoom levels for the
// session only, so the shell's zoom is stored here and handed to each new
// shell window as its starting zoom. Page zoom stays per site and per session,
// as in a browser; the settings offer a way back to 100% for all of it, for a
// reader who zoomed by accident and does not know the shortcut.

let shellFactor = 1

/** Read before the first window opens, so the shell never starts at 100% and jumps. */
export async function loadShellZoom(settings: SecureSettings): Promise<void> {
  shellFactor = await settings.getInterfaceZoom()
}

/** The zoom a new shell window starts at. */
export function shellZoomFactor(): number {
  return shellFactor
}

function shellWindows(coordinator: BrowserCoordinator): BrowserWindow[] {
  return BrowserWindow.getAllWindows().filter(
    (window) => !window.isDestroyed() && coordinator.windowOf(window.webContents)
  )
}

export function registerZoomSettingHandlers(
  coordinator: BrowserCoordinator,
  settings: SecureSettings
): void {
  // Read from the shell itself rather than the stored value: keys and the
  // wheel change it without going through here.
  ipcMain.handle(ELECTRON_IPC.zoomGetInterface, (event) => {
    coordinator.requireWindow(event)
    return event.sender.getZoomFactor()
  })
  ipcMain.handle(ELECTRON_IPC.zoomSetInterface, async (event, factor: number) => {
    coordinator.requireWindow(event)
    if (!isZoomFactor(factor)) throw new Error("Invalid zoom factor")
    for (const window of shellWindows(coordinator)) window.webContents.setZoomFactor(factor)
    if (factor === shellFactor) return
    shellFactor = factor
    await settings.setInterfaceZoom(factor)
  })
  ipcMain.handle(ELECTRON_IPC.zoomResetPages, (event) => {
    coordinator.requireWindow(event)
    // Tabs, popups and the panel page all live in the browser session.
    const browserSession = session.fromPartition(BROWSER_SESSION_PARTITION)
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed() && contents.session === browserSession) contents.setZoomFactor(1)
    }
  })
}
