import { randomUUID } from "node:crypto"
import {
  BrowserWindow,
  clipboard,
  ContextMenuParams,
  dialog,
  IpcMainInvokeEvent,
  Menu,
  MenuItemConstructorOptions,
  Rectangle,
  shell,
  WebContents,
  WebContentsView
} from "electron"
import {
  ELECTRON_IPC,
  ElectronOpenTarget,
  ElectronPoint,
  ElectronRect,
  ElectronRedirectRule,
  ElectronTabState
} from "@once/platform-electron/bridge"
import {
  normalizeBrowserUrl,
  resolveOpenDisposition
} from "@once/platform-electron/navigation"
import { storeReaderDocument } from "./ReaderProtocol"

interface TabEntry {
  id: string
  view: WebContentsView
  ownerId: number
  title: string
  loading: boolean
  audible: boolean
  muted: boolean
}

interface WindowEntry {
  window: BrowserWindow
  tabs: string[]
  activeId: string | null
  backgroundColor: string
  backgroundReady: Promise<void>
  resolveBackgroundReady: () => void
  bounds: Rectangle
  closing: boolean
}

interface CreateWindowOptions {
  url?: string
  tabId?: string
  point?: ElectronPoint
}

interface CompiledRedirect {
  match: RegExp
  replacement: string
}

type WindowFactory = (bounds?: Rectangle) => BrowserWindow

export class BrowserCoordinator {
  private readonly tabs = new Map<string, TabEntry>()
  private readonly windows = new Map<number, WindowEntry>()
  private redirects: CompiledRedirect[] = []

  constructor(
    private readonly createShellWindow: WindowFactory,
    private readonly shellEntry: string
  ) {}

  async createWindow(options: CreateWindowOptions = {}): Promise<BrowserWindow> {
    const bounds = options.point
      ? this.detachedBounds(options.tabId, options.point)
      : undefined
    const window = this.createShellWindow(bounds)
    let resolveBackgroundReady!: () => void
    const backgroundReady = new Promise<void>((resolve) => {
      resolveBackgroundReady = resolve
    })
    const state: WindowEntry = {
      window,
      tabs: [],
      activeId: null,
      backgroundColor: window.getBackgroundColor(),
      backgroundReady,
      resolveBackgroundReady,
      bounds: { x: 0, y: 0, width: 0, height: 0 },
      closing: false
    }
    this.windows.set(window.webContents.id, state)
    this.bindWindow(state)
    window.once("ready-to-show", () => window.show())

    try {
      await window.loadURL(this.shellEntry)
      await state.backgroundReady
      if (options.tabId && this.tabs.has(options.tabId)) {
        this.moveTab(state, options.tabId)
      } else {
        await this.createTab(state, options.url || "about:blank", true)
      }
      this.focusWindow(state)
      setTimeout(() => this.focusWindow(state), 0)
      return window
    } catch (error) {
      this.windows.delete(window.webContents.id)
      if (!window.isDestroyed()) window.destroy()
      throw error
    }
  }

  requireWindow(event: IpcMainInvokeEvent): WindowEntry {
    const state = this.windows.get(event.sender.id)
    if (
      !state ||
      state.window.isDestroyed() ||
      event.sender !== state.window.webContents ||
      event.senderFrame !== state.window.webContents.mainFrame
    ) {
      throw new Error("Untrusted IPC sender")
    }
    return state
  }

  getAll(state: WindowEntry): ElectronTabState[] {
    return state.tabs.flatMap((id) => {
      const entry = this.tabs.get(id)
      if (!entry) return []
      const contents = entry.view.webContents
      return [{
        id,
        url: contents.isDestroyed()
          ? "about:blank"
          : contents.getURL() || "about:blank",
        title: entry.title || "New tab",
        loading: entry.loading,
        canGoBack:
          !contents.isDestroyed() && contents.navigationHistory.canGoBack(),
        canGoForward:
          !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
        audible: entry.audible,
        muted: entry.muted,
        active: id === state.activeId
      }]
    })
  }

  async createTab(
    state: WindowEntry,
    url = "about:blank",
    active = true
  ): Promise<string> {
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
    view.setBackgroundColor(state.backgroundColor)

    const id = randomUUID()
    const entry: TabEntry = {
      id,
      view,
      ownerId: state.window.webContents.id,
      title: "New tab",
      loading: false,
      audible: false,
      muted: false
    }
    this.tabs.set(id, entry)
    state.tabs.push(id)
    this.bindTab(entry)

    if (active || !state.activeId) this.activate(state, id)
    this.load(entry, normalized)
    this.notify(state)
    return id
  }

  async openUrl(
    state: WindowEntry,
    url: string,
    target: ElectronOpenTarget
  ): Promise<void> {
    const normalized = normalizeBrowserUrl(url)
    const disposition = resolveOpenDisposition(target)
    if (disposition === "background") {
      await this.createTab(state, normalized, false)
    } else if (disposition === "foreground") {
      await this.createTab(state, normalized, true)
    } else if (!state.activeId) {
      await this.createTab(state, normalized, true)
    } else {
      await this.navigate(state, state.activeId, normalized)
    }
  }

  setBackgroundColor(state: WindowEntry, color: string): void {
    if (typeof color !== "string" || color.length === 0 || color.length > 100) {
      throw new Error("Invalid background color")
    }
    state.window.setBackgroundColor(color)
    state.backgroundColor = color
    state.resolveBackgroundReady()
    for (const id of state.tabs) {
      const entry = this.tabs.get(id)
      if (entry && !entry.view.webContents.isDestroyed()) {
        entry.view.setBackgroundColor(color)
      }
    }
  }

  async openReader(
    state: WindowEntry,
    html: string,
    sourceUrl: string,
    target: ElectronOpenTarget
  ): Promise<void> {
    if (typeof html !== "string" || html.length < 20 || html.length > 20_000_000) {
      throw new Error("Invalid reader document")
    }
    const readerUrl = storeReaderDocument(sourceUrl, html)
    const disposition = resolveOpenDisposition(target)
    if (disposition === "current" && state.activeId) {
      this.load(this.requireOwnedTab(state, state.activeId), readerUrl)
      return
    }
    const id = await this.createTab(state, "about:blank", disposition !== "background")
    this.load(this.requireOwnedTab(state, id), readerUrl)
  }

  activate(state: WindowEntry, id: string): void {
    const entry = this.requireOwnedTab(state, id)
    if (state.activeId === id) return

    const previous = state.activeId ? this.tabs.get(state.activeId) : undefined
    if (previous) state.window.contentView.removeChildView(previous.view)

    state.activeId = id
    state.window.contentView.addChildView(entry.view)
    if (state.bounds.width > 0 && state.bounds.height > 0) {
      entry.view.setBounds(state.bounds)
    }
    entry.view.webContents.focus()
    this.notify(state)
  }

  close(state: WindowEntry, id: string): void {
    const entry = this.requireOwnedTab(state, id)
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.close({ waitForBeforeUnload: true })
    }
  }

  async duplicate(state: WindowEntry, id: string): Promise<string> {
    const entry = this.requireOwnedTab(state, id)
    const url = entry.view.webContents.getURL() || "about:blank"
    return this.createTab(state, url, true)
  }

  reorder(state: WindowEntry, id: string, beforeId?: string): void {
    this.requireOwnedTab(state, id)
    if (beforeId) this.requireOwnedTab(state, beforeId)
    this.insertTabId(state.tabs, id, beforeId)
    this.notify(state)
  }

  moveHere(state: WindowEntry, id: string, beforeId?: string): void {
    if (beforeId) this.requireOwnedTab(state, beforeId)
    this.moveTab(state, id, beforeId)
  }

  async detach(
    state: WindowEntry,
    id: string,
    point?: ElectronPoint
  ): Promise<void> {
    this.requireOwnedTab(state, id)
    if (point) this.validatePoint(point)
    await this.createWindow({ tabId: id, point })
  }

  async openDroppedUrls(state: WindowEntry, urls: string[]): Promise<void> {
    if (!Array.isArray(urls) || urls.length === 0 || urls.length > 20) {
      throw new Error("Invalid dropped URLs")
    }
    const normalized = urls.map((url) => normalizeBrowserUrl(url))
    for (let index = 0; index < normalized.length; index += 1) {
      await this.createTab(state, normalized[index], index === normalized.length - 1)
    }
  }

  toggleMuted(state: WindowEntry, id: string): void {
    const entry = this.requireOwnedTab(state, id)
    const muted = !entry.view.webContents.isAudioMuted()
    entry.view.webContents.setAudioMuted(muted)
    entry.muted = muted
    this.notify(state)
  }

  async navigate(state: WindowEntry, id: string, url: string): Promise<void> {
    this.load(this.requireOwnedTab(state, id), normalizeBrowserUrl(url))
  }

  back(state: WindowEntry, id: string): void {
    const history = this.requireOwnedTab(state, id).view.webContents.navigationHistory
    if (history.canGoBack()) history.goBack()
  }

  forward(state: WindowEntry, id: string): void {
    const history = this.requireOwnedTab(state, id).view.webContents.navigationHistory
    if (history.canGoForward()) history.goForward()
  }

  reload(state: WindowEntry, id: string): void {
    this.requireOwnedTab(state, id).view.webContents.reload()
  }

  stop(state: WindowEntry, id: string): void {
    this.requireOwnedTab(state, id).view.webContents.stop()
  }

  setBounds(state: WindowEntry, requested: ElectronRect): void {
    for (const value of Object.values(requested)) {
      if (!Number.isFinite(value)) throw new Error("Invalid browser bounds")
    }

    const content = state.window.getContentBounds()
    const x = Math.max(0, Math.round(requested.x))
    const y = Math.max(0, Math.round(requested.y))
    state.bounds = {
      x,
      y,
      width: Math.max(0, Math.min(Math.round(requested.width), content.width - x)),
      height: Math.max(0, Math.min(Math.round(requested.height), content.height - y))
    }
    const active = state.activeId ? this.tabs.get(state.activeId) : undefined
    active?.view.setBounds(state.bounds)
  }

  setFullscreen(state: WindowEntry, fullscreen: boolean): void {
    if (typeof fullscreen !== "boolean") throw new Error("Invalid fullscreen state")
    state.window.setFullScreen(fullscreen)
  }

  setRedirects(redirects: ElectronRedirectRule[]): void {
    if (!Array.isArray(redirects) || redirects.length > 100) {
      throw new Error("Invalid redirect rules")
    }
    this.redirects = redirects.map((redirect) => {
      if (
        typeof redirect?.match_url !== "string" ||
        typeof redirect?.replace_url !== "string" ||
        redirect.match_url.length > 2048 ||
        redirect.replace_url.length > 2048
      ) {
        throw new Error("Invalid redirect rule")
      }
      return {
        match: new RegExp(redirect.match_url),
        replacement: redirect.replace_url
      }
    })
  }

  showTabMenu(state: WindowEntry, id: string, point: ElectronPoint): void {
    this.requireOwnedTab(state, id)
    this.validatePoint(point)
    const inspect = () => this.inspect(state.window.webContents, point.x, point.y)
    const template: MenuItemConstructorOptions[] = [
      { label: "Inspect", click: inspect },
      { type: "separator" },
      { label: "Duplicate Tab", click: () => void this.duplicate(state, id) },
      { label: "Move Tab to New Window", click: () => void this.detach(state, id) },
      { label: "Close Tab", click: () => this.close(state, id) }
    ]
    Menu.buildFromTemplate(template).popup({ window: state.window })
  }

  private bindWindow(state: WindowEntry): void {
    const { window } = state
    window.webContents.on("context-menu", (_event, params) => {
      this.showContentsMenu(state, window.webContents, params)
    })
    window.on("app-command", (_event, command) => {
      if (!state.activeId) return
      if (command === "browser-backward") this.back(state, state.activeId)
      if (command === "browser-forward") this.forward(state, state.activeId)
    })
    window.on("enter-full-screen", () => this.sendFullscreen(state, true))
    window.on("leave-full-screen", () => this.sendFullscreen(state, false))
    window.on("close", () => {
      state.closing = true
    })
    window.on("closed", () => {
      this.windows.delete(window.webContents.id)
      for (const id of [...state.tabs]) {
        const entry = this.tabs.get(id)
        this.tabs.delete(id)
        if (entry && !entry.view.webContents.isDestroyed()) {
          entry.view.webContents.close({ waitForBeforeUnload: false })
        }
      }
      state.tabs = []
      state.activeId = null
    })
  }

  private bindTab(entry: TabEntry): void {
    const contents = entry.view.webContents
    const changed = () => this.notifyOwner(entry)

    contents.on("did-start-loading", () => {
      entry.loading = true
      changed()
    })
    contents.on("did-stop-loading", () => {
      entry.loading = false
      changed()
    })
    contents.on("did-start-navigation", (event) => {
      if (!event.isMainFrame || event.isSameDocument) return
      entry.title = "New tab"
      changed()
    })
    contents.on("did-navigate", changed)
    contents.on("did-navigate-in-page", changed)
    contents.on("page-title-updated", (_event, title) => {
      entry.title = title || "New tab"
      changed()
    })
    contents.on("audio-state-changed", (event) => {
      entry.audible = event.audible
      changed()
    })
    contents.on("update-target-url", (_event, url) => {
      const owner = this.windows.get(entry.ownerId)
      if (owner && owner.activeId === entry.id && !owner.window.isDestroyed()) {
        owner.window.webContents.send(ELECTRON_IPC.windowTargetUrlChanged, url)
      }
    })
    contents.on("will-navigate", (event, url) => {
      try {
        const normalized = normalizeBrowserUrl(url)
        const redirected = this.applyRedirects(normalized)
        if (redirected !== normalized) {
          event.preventDefault()
          this.load(entry, normalizeBrowserUrl(redirected))
        }
      } catch {
        event.preventDefault()
      }
    })
    contents.on("will-prevent-unload", (event) => {
      const owner = this.windows.get(entry.ownerId)
      if (!owner || owner.window.isDestroyed()) return
      const choice = dialog.showMessageBoxSync(owner.window, {
        type: "question",
        buttons: ["Leave", "Stay"],
        defaultId: 0,
        cancelId: 1,
        title: "Do you want to leave this site?",
        message: "Changes you made may not be saved."
      })
      if (choice === 0) event.preventDefault()
    })
    contents.on("enter-html-full-screen", () => {
      const owner = this.windows.get(entry.ownerId)
      owner?.window.setFullScreen(true)
    })
    contents.on("leave-html-full-screen", () => {
      const owner = this.windows.get(entry.ownerId)
      owner?.window.setFullScreen(false)
    })
    contents.on("before-input-event", (event, input) => {
      if (input.type !== "keyUp") return
      const owner = this.windows.get(entry.ownerId)
      if (!owner) return
      if (input.key === "F11") {
        event.preventDefault()
        owner.window.setFullScreen(!owner.window.isFullScreen())
      } else if (input.key === "Escape" && owner.window.isFullScreen()) {
        event.preventDefault()
        owner.window.setFullScreen(false)
      }
    })
    contents.setWindowOpenHandler(({ url, disposition }) => {
      const owner = this.windows.get(entry.ownerId)
      if (!owner) return { action: "deny" }
      try {
        const normalized = normalizeBrowserUrl(url)
        if (disposition === "new-window") {
          void this.createWindow({ url: normalized })
        } else {
          void this.createTab(owner, normalized, disposition !== "background-tab")
        }
      } catch {
        // Unsupported schemes are intentionally denied.
      }
      return { action: "deny" }
    })
    contents.on("context-menu", (_event, params) => {
      const owner = this.windows.get(entry.ownerId)
      if (owner) this.showContentsMenu(owner, contents, params)
    })
    contents.on("destroyed", () => this.finalizeClosedTab(entry))
  }

  private showContentsMenu(
    owner: WindowEntry,
    contents: WebContents,
    params: ContextMenuParams
  ): void {
    if (owner.window.isDestroyed() || contents.isDestroyed()) return
    const template: MenuItemConstructorOptions[] = [
      { label: "Inspect", click: () => this.inspect(contents, params.x, params.y) }
    ]

    if (params.isEditable) {
      template.push(
        { type: "separator" },
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "selectAll", enabled: params.editFlags.canSelectAll }
      )
    } else if (params.selectionText) {
      const selection = params.selectionText
      template.push(
        { type: "separator" },
        { label: "Copy", click: () => clipboard.writeText(selection) },
        {
          label: "Search the Web",
          click: () =>
            void this.createTab(
              owner,
              `https://www.google.com/search?q=${encodeURIComponent(selection)}`,
              true
            )
        }
      )
    }

    const link = this.tryNormalizeUrl(params.linkURL)
    if (link) {
      template.push(
        { type: "separator" },
        { label: "Open in New Tab", click: () => void this.createTab(owner, link, true) },
        {
          label: "Open in Background Tab",
          click: () => void this.createTab(owner, link, false)
        },
        { label: "Open in New Once Window", click: () => void this.createWindow({ url: link }) },
        { label: "Open in Default Browser", click: () => void shell.openExternal(link) },
        { label: "Copy Link Address", click: () => clipboard.writeText(link) }
      )
    }

    Menu.buildFromTemplate(template).popup({ window: owner.window })
  }

  private inspect(contents: WebContents, x: number, y: number): void {
    if (contents.isDestroyed()) return
    contents.inspectElement(Math.round(x), Math.round(y))
    setTimeout(() => {
      if (!contents.isDestroyed() && contents.isDevToolsOpened()) {
        contents.devToolsWebContents?.focus()
      }
    }, 0)
  }

  private focusWindow(state: WindowEntry): void {
    if (state.window.isDestroyed()) return
    if (state.window.isMinimized()) state.window.restore()
    state.window.show()
    state.window.moveTop()
    state.window.focus()
    const active = state.activeId ? this.tabs.get(state.activeId) : undefined
    active?.view.webContents.focus()
  }

  private moveTab(state: WindowEntry, id: string, beforeId?: string): void {
    const entry = this.tabs.get(id)
    if (!entry) throw new Error(`Unknown tab: ${id}`)
    const source = this.windows.get(entry.ownerId)
    if (!source) throw new Error("Tab owner is unavailable")
    if (source === state) {
      this.reorder(state, id, beforeId)
      return
    }

    const oldIndex = source.tabs.indexOf(id)
    if (source.activeId === id) {
      source.window.contentView.removeChildView(entry.view)
      source.activeId = null
    }
    source.tabs.splice(oldIndex, 1)

    entry.ownerId = state.window.webContents.id
    entry.view.setBackgroundColor(state.backgroundColor)
    this.insertTabId(state.tabs, id, beforeId)
    this.activate(state, id)

    if (source.tabs.length > 0 && !source.activeId) {
      const next = source.tabs[Math.min(oldIndex, source.tabs.length - 1)]
      this.activate(source, next)
    } else {
      this.notify(source)
    }
    if (source.tabs.length === 0 && this.windows.size > 1) {
      source.closing = true
      source.window.destroy()
    }
  }

  private finalizeClosedTab(entry: TabEntry): void {
    if (!this.tabs.delete(entry.id)) return
    const owner = this.windows.get(entry.ownerId)
    if (!owner) return
    const index = owner.tabs.indexOf(entry.id)
    if (index < 0) return
    if (owner.activeId === entry.id) {
      owner.window.contentView.removeChildView(entry.view)
      owner.activeId = null
    }
    owner.tabs.splice(index, 1)
    if (owner.closing) return
    if (owner.tabs.length === 0) {
      if (this.windows.size > 1) {
        owner.closing = true
        owner.window.destroy()
      }
      else void this.createTab(owner, "about:blank", true)
      return
    }
    if (!owner.activeId) {
      this.activate(owner, owner.tabs[Math.min(index, owner.tabs.length - 1)])
    } else {
      this.notify(owner)
    }
  }

  private insertTabId(ids: string[], id: string, beforeId?: string): void {
    const oldIndex = ids.indexOf(id)
    if (oldIndex >= 0) ids.splice(oldIndex, 1)
    const targetIndex = beforeId ? ids.indexOf(beforeId) : -1
    if (targetIndex >= 0) ids.splice(targetIndex, 0, id)
    else ids.push(id)
  }

  private requireOwnedTab(state: WindowEntry, id: string): TabEntry {
    const entry = this.tabs.get(id)
    if (!entry || entry.ownerId !== state.window.webContents.id) {
      throw new Error(`Unknown tab: ${id}`)
    }
    return entry
  }

  private detachedBounds(tabId: string | undefined, point: ElectronPoint): Rectangle {
    this.validatePoint(point)
    const entry = tabId ? this.tabs.get(tabId) : undefined
    const owner = entry ? this.windows.get(entry.ownerId) : undefined
    const current = owner?.window.getBounds()
    return {
      x: Math.round(point.x - 80),
      y: Math.round(point.y - 16),
      width: current?.width || 900,
      height: current?.height || 700
    }
  }

  private validatePoint(point: ElectronPoint): void {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      throw new Error("Invalid point")
    }
  }

  private applyRedirects(url: string): string {
    for (const redirect of this.redirects) {
      url = url.replace(redirect.match, redirect.replacement)
    }
    return url
  }

  private tryNormalizeUrl(url: string): string | null {
    if (!url) return null
    try {
      return normalizeBrowserUrl(url)
    } catch {
      return null
    }
  }

  private load(entry: TabEntry, url: string): void {
    entry.view.webContents.loadURL(url).catch((error) => {
      if (error?.code !== "ERR_ABORTED") {
        console.error(`Failed to load ${url}`, error)
      }
    })
  }

  private sendFullscreen(state: WindowEntry, fullscreen: boolean): void {
    if (!state.window.isDestroyed()) {
      state.window.webContents.send(ELECTRON_IPC.windowFullscreenChanged, fullscreen)
    }
  }

  private notifyOwner(entry: TabEntry): void {
    const owner = this.windows.get(entry.ownerId)
    if (owner) this.notify(owner)
  }

  private notify(state: WindowEntry): void {
    if (!state.window.isDestroyed()) {
      state.window.webContents.send(ELECTRON_IPC.tabsChanged, this.getAll(state))
    }
  }
}
