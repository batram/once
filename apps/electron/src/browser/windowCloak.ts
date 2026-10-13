import { app, BrowserWindow } from "electron"
import path from "node:path"

/** native/WindowCloak.cpp, built by scripts/build-native.js. */
interface WindowCloakAddon {
  setCloaked(handle: Buffer, cloaked: boolean): boolean
  fillBackground(handle: Buffer): boolean
}

let addon: WindowCloakAddon | null | undefined

function loadAddon(): WindowCloakAddon | null {
  if (addon !== undefined) return addon
  addon = null
  if (process.platform !== "win32") return addon
  const file = app.isPackaged
    ? path.join(process.resourcesPath, "window-cloak.node")
    : path.resolve(__dirname, "../../../.native/window-cloak.node")
  try {
    // dlopen rather than require: webpack would try to bundle the binary.
    const loaded = { exports: {} as WindowCloakAddon }
    process.dlopen(loaded, file)
    addon = loaded.exports
  } catch (error) {
    console.warn("Window cloak addon unavailable; windows may flash white when shown", error)
  }
  return addon
}

/**
 * Shows a window that has never been shown without the white frame Windows
 * presents before Chromium's first one (visible when window animations are
 * off): the window is shown cloaked, its surface painted with its
 * backgroundColor, then uncloaked. Elsewhere, or once shown, just `show`.
 */
export function showWithoutFlash(window: BrowserWindow, show: () => void = () => window.show()): void {
  const native = window.isVisible() ? null : loadAddon()
  if (!native) {
    show()
    return
  }
  const handle = window.getNativeWindowHandle()
  const cloaked = native.setCloaked(handle, true)
  try {
    show()
    if (cloaked) native.fillBackground(handle)
  } finally {
    if (cloaked) native.setCloaked(handle, false)
  }
}
