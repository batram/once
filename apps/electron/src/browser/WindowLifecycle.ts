import { BrowserWindow } from "electron"
import { ELECTRON_IPC, ElectronRect } from "@once/platform-electron/bridge"
import { NativeMenus } from "./NativeMenus"
import { TabEntry, WindowEntry } from "./BrowserState"

// Test runs launch a real window, which normally steals OS focus from whatever
// the developer is doing. ONCE_ELECTRON_TEST_BACKGROUND keeps the window
// visible and rendering, but never activates it.
export function isBackgroundMode(): boolean {
  return process.env.ONCE_ELECTRON_TEST_BACKGROUND === "1"
}

export function showWindow(window: BrowserWindow): void {
  if (window.isDestroyed()) return
  if (isBackgroundMode()) window.showInactive()
  else window.show()
}

interface WindowLifecycleActions {
  activeEntry(owner: WindowEntry): TabEntry | undefined
  back(owner: WindowEntry, id: string): void
  close(owner: WindowEntry): void
  forward(owner: WindowEntry, id: string): void
}

export class WindowLifecycle {
  constructor(
    private readonly menus: NativeMenus,
    private readonly actions: WindowLifecycleActions
  ) {}

  createState(window: BrowserWindow): WindowEntry {
    let resolveBackgroundReady!: () => void
    const backgroundReady = new Promise<void>((resolve) => {
      resolveBackgroundReady = resolve
    })
    return {
      window,
      tabs: [],
      activeId: null,
      backgroundColor: window.getBackgroundColor(),
      backgroundReady,
      resolveBackgroundReady,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      normalBounds: null,
      fullscreen: false,
      closing: false,
      forwardedKeys: new Set()
    }
  }

  bind(owner: WindowEntry): void {
    const { window } = owner
    window.webContents.on("context-menu", (_event, params) => {
      this.menus.showContentsMenu(owner, window.webContents, params)
    })
    window.on("app-command", (event, command) => {
      if (!owner.activeId) return
      if (command === "browser-backward") {
        event.preventDefault()
        this.actions.back(owner, owner.activeId)
      }
      if (command === "browser-forward") {
        event.preventDefault()
        this.actions.forward(owner, owner.activeId)
      }
    })
    window.webContents.on("focus", () => {
      if (window.isDestroyed()) return
      window.webContents.send(ELECTRON_IPC.windowNativeFocusChanged, "shell")
    })
    window.on("enter-full-screen", () => {
      owner.fullscreen = true
      this.sendFullscreen(owner, true)
    })
    window.on("leave-full-screen", () => this.leaveFullscreen(owner))
    window.on("close", () => {
      owner.closing = true
    })
    window.on("closed", () => this.actions.close(owner))
  }

  focus(owner: WindowEntry): void {
    if (owner.window.isDestroyed()) return
    if (owner.window.isMinimized()) owner.window.restore()
    showWindow(owner.window)
    // In-app focus still moves so focus assertions stay meaningful; only the
    // OS-level window activation is skipped.
    if (!isBackgroundMode()) {
      owner.window.moveTop()
      owner.window.focus()
    }
    this.actions.activeEntry(owner)?.view.webContents.focus()
  }

  setBounds(owner: WindowEntry, requested: ElectronRect): void {
    for (const value of Object.values(requested)) {
      if (!Number.isFinite(value)) throw new Error("Invalid browser bounds")
    }
    const content = owner.window.getContentBounds()
    const x = Math.max(0, Math.round(requested.x))
    const y = Math.max(0, Math.round(requested.y))
    owner.bounds = {
      x,
      y,
      width: Math.max(0, Math.min(Math.round(requested.width), content.width - x)),
      height: Math.max(0, Math.min(Math.round(requested.height), content.height - y))
    }
    const active = this.actions.activeEntry(owner)
    active?.view.setBounds(owner.bounds)
    if (!owner.fullscreen && !active?.htmlFullscreen) owner.normalBounds = null
  }

  setFullscreen(owner: WindowEntry, fullscreen: boolean): void {
    if (typeof fullscreen !== "boolean") throw new Error("Invalid fullscreen state")
    if (fullscreen) owner.normalBounds ??= { ...owner.bounds }
    else this.restoreBounds(owner)
    owner.window.setFullScreen(fullscreen)
  }

  private leaveFullscreen(owner: WindowEntry): void {
    owner.fullscreen = false
    this.restoreBounds(owner)
    this.sendFullscreen(owner, false)
    const active = this.actions.activeEntry(owner)
    if (active?.htmlFullscreen && !active.view.webContents.isDestroyed()) {
      void active.view.webContents.executeJavaScript("document.exitFullscreen()")
    }
  }

  private restoreBounds(owner: WindowEntry): void {
    if (!owner.normalBounds) return
    owner.bounds = { ...owner.normalBounds }
    this.actions.activeEntry(owner)?.view.setBounds(owner.bounds)
  }

  private sendFullscreen(owner: WindowEntry, fullscreen: boolean): void {
    if (!owner.window.isDestroyed()) {
      owner.window.webContents.send(ELECTRON_IPC.windowFullscreenChanged, fullscreen)
    }
  }
}
