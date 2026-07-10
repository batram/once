import { BrowserWindow, Rectangle, WebContentsView } from "electron"
import {
  ELECTRON_IPC,
  ElectronOpenTarget,
  ElectronRect,
  ElectronTabState
} from "@once/platform-electron/bridge"
import {
  normalizeBrowserUrl,
  resolveOpenDisposition
} from "@once/platform-electron/navigation"

interface TabEntry {
  view: WebContentsView
  title: string
  loading: boolean
  audible: boolean
}

export class TabManager {
  private readonly tabs = new Map<string, TabEntry>()
  private activeId: string | null = null
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 }
  private closing = false

  constructor(private readonly window: BrowserWindow) {
    this.window.on("closed", () => {
      this.closing = true
      for (const entry of this.tabs.values()) {
        if (!entry.view.webContents.isDestroyed()) {
          entry.view.webContents.close({ waitForBeforeUnload: false })
        }
      }
      this.tabs.clear()
    })
  }

  getAll(): ElectronTabState[] {
    return Array.from(this.tabs.entries()).map(([id, entry]) => {
      const contents = entry.view.webContents
      return {
        id,
        url: contents.isDestroyed() ? "about:blank" : contents.getURL() || "about:blank",
        title: entry.title || "New tab",
        loading: entry.loading,
        canGoBack:
          !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
        canGoForward:
          !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
        audible: entry.audible,
        active: id === this.activeId
      }
    })
  }

  async create(url = "about:blank", active = true): Promise<string> {
    const normalized = normalizeBrowserUrl(url)
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        partition: "persist:once-browser-v2"
      }
    })
    view.setBackgroundColor("#ffffff")

    const id = String(view.webContents.id)
    const entry: TabEntry = {
      view,
      title: "New tab",
      loading: false,
      audible: false
    }
    this.tabs.set(id, entry)
    this.bindEntry(id, entry)

    if (active || !this.activeId) this.activate(id)
    this.load(entry, normalized)
    this.notify()
    return id
  }

  async openUrl(url: string, target: ElectronOpenTarget): Promise<void> {
    const normalized = normalizeBrowserUrl(url)
    const disposition = resolveOpenDisposition(target)
    if (disposition === "background") {
      await this.create(normalized, false)
      return
    }
    if (disposition === "foreground") {
      await this.create(normalized, true)
      return
    }

    if (!this.activeId) {
      await this.create(normalized, true)
      return
    }
    await this.navigate(this.activeId, normalized)
  }

  activate(id: string): void {
    const next = this.requireTab(id)
    if (this.activeId === id) return

    const previous = this.activeId ? this.tabs.get(this.activeId) : undefined
    if (previous) this.window.contentView.removeChildView(previous.view)

    this.activeId = id
    this.window.contentView.addChildView(next.view)
    if (this.bounds.width > 0 && this.bounds.height > 0) {
      next.view.setBounds(this.bounds)
    }
    next.view.webContents.focus()
    this.notify()
  }

  async close(id: string): Promise<void> {
    const ids = Array.from(this.tabs.keys())
    const index = ids.indexOf(id)
    const entry = this.requireTab(id)
    const wasActive = this.activeId === id

    if (wasActive) {
      this.window.contentView.removeChildView(entry.view)
      this.activeId = null
    }
    this.tabs.delete(id)
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.close({ waitForBeforeUnload: false })
    }

    if (this.closing) return
    if (this.tabs.size === 0) {
      await this.create("about:blank", true)
      return
    }
    if (wasActive) {
      const remaining = Array.from(this.tabs.keys())
      this.activate(remaining[Math.min(index, remaining.length - 1)])
    } else {
      this.notify()
    }
  }

  async navigate(id: string, url: string): Promise<void> {
    this.load(this.requireTab(id), normalizeBrowserUrl(url))
  }

  back(id: string): void {
    const history = this.requireTab(id).view.webContents.navigationHistory
    if (history.canGoBack()) history.goBack()
  }

  forward(id: string): void {
    const history = this.requireTab(id).view.webContents.navigationHistory
    if (history.canGoForward()) history.goForward()
  }

  reload(id: string): void {
    this.requireTab(id).view.webContents.reload()
  }

  stop(id: string): void {
    this.requireTab(id).view.webContents.stop()
  }

  setBounds(requested: ElectronRect): void {
    for (const value of Object.values(requested)) {
      if (!Number.isFinite(value)) throw new Error("Invalid browser bounds")
    }

    const content = this.window.getContentBounds()
    const x = Math.max(0, Math.round(requested.x))
    const y = Math.max(0, Math.round(requested.y))
    this.bounds = {
      x,
      y,
      width: Math.max(0, Math.min(Math.round(requested.width), content.width - x)),
      height: Math.max(0, Math.min(Math.round(requested.height), content.height - y))
    }

    const active = this.activeId ? this.tabs.get(this.activeId) : undefined
    active?.view.setBounds(this.bounds)
  }

  private bindEntry(id: string, entry: TabEntry): void {
    const contents = entry.view.webContents
    const changed = () => this.notify()

    contents.on("did-start-loading", () => {
      entry.loading = true
      changed()
    })
    contents.on("did-stop-loading", () => {
      entry.loading = false
      changed()
    })
    contents.on("did-navigate", changed)
    contents.on("did-navigate-in-page", changed)
    contents.on("page-title-updated", (_event, title) => {
      entry.title = title || "New tab"
      changed()
    })
    contents.on("media-started-playing", () => {
      entry.audible = true
      changed()
    })
    contents.on("media-paused", () => {
      entry.audible = false
      changed()
    })
    contents.on("will-navigate", (event, url) => {
      try {
        normalizeBrowserUrl(url)
      } catch {
        event.preventDefault()
      }
    })
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const normalized = normalizeBrowserUrl(url)
        this.create(normalized, true)
      } catch {
        // Unsupported schemes are intentionally denied.
      }
      return { action: "deny" }
    })
    contents.on("destroyed", () => {
      if (!this.closing && this.tabs.has(id)) this.close(id)
    })
  }

  private requireTab(id: string): TabEntry {
    const entry = this.tabs.get(id)
    if (!entry) throw new Error(`Unknown tab: ${id}`)
    return entry
  }

  private load(entry: TabEntry, url: string): void {
    entry.view.webContents.loadURL(url).catch((error) => {
      if (error?.code !== "ERR_ABORTED") {
        console.error(`Failed to load ${url}`, error)
      }
    })
  }

  private notify(): void {
    if (!this.window.isDestroyed()) {
      this.window.webContents.send(ELECTRON_IPC.tabsChanged, this.getAll())
    }
  }
}
