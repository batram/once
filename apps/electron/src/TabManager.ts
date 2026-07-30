import { randomUUID } from "node:crypto"
import {
  BrowserWindow,
  IpcMainInvokeEvent,
  Rectangle,
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
import {
  hasReaderDocument,
  sourceUrlFromReaderUrl,
  storeReaderDocument
} from "./ReaderProtocol"
import { TabEntry, WindowEntry } from "./browser/BrowserState"
import { NativeMenus } from "./browser/NativeMenus"
import { NavigationErrors } from "./browser/NavigationErrors"
import { SourcePicker } from "./browser/SourcePicker"
import { TabEvents } from "./browser/TabEvents"
import { TabOwnership } from "./browser/TabOwnership"
import { WindowLifecycle } from "./browser/WindowLifecycle"

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
  private readonly menus: NativeMenus
  private readonly navigationErrors: NavigationErrors
  private readonly sourcePicker = new SourcePicker()
  private readonly tabEvents: TabEvents
  private readonly ownership: TabOwnership
  private readonly windowLifecycle: WindowLifecycle
  private redirects: CompiledRedirect[] = []

  constructor(
    private readonly createShellWindow: WindowFactory,
    private readonly shellEntry: string
  ) {
    this.menus = new NativeMenus({
      close: (owner, id) => this.close(owner, id),
      createTab: (owner, url, active) => this.createTab(owner, url, active),
      createWindow: async (url) => { await this.createWindow({ url }) },
      detach: (owner, id) => this.detach(owner, id),
      duplicate: (owner, id) => this.duplicate(owner, id),
      normalizeUrl: (url) => this.tryNormalizeUrl(url),
      toggleMuted: (owner, id) => this.toggleMuted(owner, id)
    })
    this.navigationErrors = new NavigationErrors({
      ownerFor: (entry) => this.ownership.ownerFor(entry),
      notify: (entry) => this.ownership.notifyEntry(entry)
    })
    this.ownership = new TabOwnership(this.navigationErrors, {
      createBlankTab: (owner) => this.createTab(owner, "about:blank", true)
    })
    this.windowLifecycle = new WindowLifecycle(this.menus, {
      activeEntry: (owner) => owner.activeId
        ? this.ownership.get(owner.activeId)
        : undefined,
      back: (owner, id) => this.back(owner, id),
      close: (owner) => this.ownership.closeWindow(owner),
      forward: (owner, id) => this.forward(owner, id)
    })
    const ownerAccess = {
      ownerFor: (entry: TabEntry) => this.ownership.ownerFor(entry),
      notify: (entry: TabEntry) => this.ownership.notifyEntry(entry)
    }
    this.tabEvents = new TabEvents(this.navigationErrors, this.menus, {
      applyRedirects: (url) => this.applyRedirects(url),
      ...ownerAccess
    }, {
      createTab: (owner, url, active) => this.createTab(owner, url, active),
      createWindow: async (url) => { await this.createWindow({ url }) },
      setFullscreen: (owner, fullscreen) => this.setFullscreen(owner, fullscreen),
      ...ownerAccess
    }, {
      finalizeClosedTab: (entry) => this.ownership.finalizeClosed(entry),
      ...ownerAccess
    })
  }

  async createWindow(options: CreateWindowOptions = {}): Promise<BrowserWindow> {
    const bounds = options.point
      ? this.detachedBounds(options.tabId, options.point)
      : undefined
    const window = this.createShellWindow(bounds)
    const state = this.windowLifecycle.createState(window)
    this.ownership.addWindow(state)
    this.windowLifecycle.bind(state)
    window.once("ready-to-show", () => window.show())

    try {
      await window.loadURL(this.shellEntry)
      await state.backgroundReady
      if (options.tabId && this.ownership.get(options.tabId)) {
        this.ownership.move(state, options.tabId)
      } else {
        await this.createTab(state, options.url || "about:blank", true)
      }
      this.windowLifecycle.focus(state)
      setTimeout(() => this.windowLifecycle.focus(state), 0)
      return window
    } catch (error) {
      this.ownership.removeWindow(state)
      if (!window.isDestroyed()) window.destroy()
      throw error
    }
  }

  requireWindow(event: IpcMainInvokeEvent): WindowEntry {
    const state = this.ownership.windows.get(event.sender.id)
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
    return this.ownership.getAll(state)
  }

  async createTab(
    state: WindowEntry,
    url = "about:blank",
    active = true
  ): Promise<string> {
    const normalized = this.normalizeTabUrl(url)
    const view = new WebContentsView({
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        disableHtmlFullscreenWindowResize: true,
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
      hasPlayedAudio: false,
      muted: false,
      displayedUrl: normalized,
      loadError: null,
      loadErrorRetryable: false,
      errorPageUrl: null,
      errorPages: new Map(),
      htmlFullscreen: false,
      pickerSession: null
    }
    this.ownership.addTab(state, entry)
    this.tabEvents.bind(entry)

    if (active || !state.activeId) this.ownership.activate(state, id)
    this.navigationErrors.load(entry, normalized)
    this.ownership.notify(state)
    return id
  }

  async openUrl(
    state: WindowEntry,
    url: string,
    target: ElectronOpenTarget
  ): Promise<void> {
    const normalized = this.normalizeTabUrl(url)
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

  showStoryMenu(
    state: WindowEntry,
    items: import("@once/platform-electron/bridge").ElectronStoryMenuItem[],
    point: ElectronPoint
  ): Promise<string | null> {
    return this.menus.showStoryMenu(state, items, point)
  }

  setBackgroundColor(state: WindowEntry, color: string): void {
    if (typeof color !== "string" || color.length === 0 || color.length > 100) {
      throw new Error("Invalid background color")
    }
    state.window.setBackgroundColor(color)
    state.backgroundColor = state.window.getBackgroundColor()
    state.resolveBackgroundReady()
    for (const id of state.tabs) {
      const entry = this.ownership.get(id)
      if (entry && !entry.view.webContents.isDestroyed()) {
        entry.view.setBackgroundColor(state.backgroundColor)
        this.navigationErrors.applyTheme(entry, state.backgroundColor)
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
      this.navigationErrors.load(this.ownership.requireOwned(state, state.activeId), readerUrl)
      return
    }
    await this.createTab(state, readerUrl, disposition !== "background")
  }

  showReaderError(state: WindowEntry, sourceUrl: string, error: string): void {
    if (!state.activeId) throw new Error("There is no active tab for the reader error")
    if (typeof error !== "string" || error.length === 0 || error.length > 10_000) {
      throw new Error("Invalid reader error")
    }
    const source = new URL(sourceUrl)
    if (source.protocol !== "http:" && source.protocol !== "https:") {
      throw new Error("Reader source must use HTTP or HTTPS")
    }
    const entry = this.ownership.requireOwned(state, state.activeId)
    this.navigationErrors.handleFailure(
      entry,
      `once-reader://${source.toString()}`,
      error,
      true
    )
  }

  activate(state: WindowEntry, id: string): void {
    this.ownership.activate(state, id)
  }

  close(state: WindowEntry, id: string): void {
    const entry = this.ownership.requireOwned(state, id)
    if (!entry.view.webContents.isDestroyed()) {
      entry.view.webContents.close({ waitForBeforeUnload: true })
    }
  }

  async duplicate(state: WindowEntry, id: string): Promise<string> {
    const entry = this.ownership.requireOwned(state, id)
    return this.createTab(state, entry.displayedUrl, true)
  }

  reorder(state: WindowEntry, id: string, beforeId?: string): void {
    this.ownership.reorder(state, id, beforeId)
  }

  moveHere(state: WindowEntry, id: string, beforeId?: string): void {
    if (beforeId) this.ownership.requireOwned(state, beforeId)
    this.ownership.move(state, id, beforeId)
  }

  async detach(
    state: WindowEntry,
    id: string,
    point?: ElectronPoint
  ): Promise<void> {
    this.ownership.requireOwned(state, id)
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
    const entry = this.ownership.requireOwned(state, id)
    const muted = !entry.view.webContents.isAudioMuted()
    entry.view.webContents.setAudioMuted(muted)
    entry.muted = muted
    this.ownership.notify(state)
  }

  // Runs the source picker overlay in the active tab and resolves with a
  // sanitized geny_match source line, or null when the user cancels. Browser
  // tabs have no preload, so the picker bundle is injected on demand and only
  // its JSON completion value crosses back; the page never gains IPC access.
  async startSourcePicker(
    state: WindowEntry,
    requestedUrl?: string
  ): Promise<string | null> {
    if (requestedUrl) {
      const normalized = this.normalizeTabUrl(requestedUrl)
      const id = await this.createTab(state, normalized, true)
      const entry = this.ownership.requireOwned(state, id)
      await this.waitForPickerPage(entry)
      return this.sourcePicker.start(entry)
    }
    if (!state.activeId) throw new Error("There is no active tab to pick from")
    const entry = this.ownership.requireOwned(state, state.activeId)
    return this.sourcePicker.start(entry)
  }

  private waitForPickerPage(entry: TabEntry): Promise<void> {
    if (!entry.view.webContents.isLoadingMainFrame()) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const contents = entry.view.webContents
      const timeout = setTimeout(() => finish(
        new Error("The page took too long to load")), 30_000)
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        contents.removeListener("did-finish-load", loaded)
        contents.removeListener("did-fail-load", failed)
        if (error) reject(error)
        else resolve()
      }
      const loaded = () => finish()
      const failed = (
        _event: Electron.Event,
        code: number,
        description: string,
        _url: string,
        isMainFrame: boolean
      ) => {
        if (isMainFrame) finish(new Error(
          `The page could not be loaded (${code}): ${description}`))
      }
      contents.once("did-finish-load", loaded)
      contents.on("did-fail-load", failed)
    })
  }

  async navigate(state: WindowEntry, id: string, url: string): Promise<void> {
    const entry = this.ownership.requireOwned(state, id)
    try {
      const normalized = this.normalizeTabUrl(url)
      const readerSource = sourceUrlFromReaderUrl(normalized)
      // Reader documents only live for the current session, so a typed or
      // bookmarked reader URL may reference a document we no longer hold.
      // Ask the shell to regenerate it through the normal reader flow.
      if (readerSource && !hasReaderDocument(readerSource)) {
        state.window.webContents.send(
          ELECTRON_IPC.tabsRegenerateReader,
          readerSource
        )
        return
      }
      this.navigationErrors.load(entry, normalized)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.navigationErrors.handleFailure(entry, url.trim(), message, false)
    }
  }

  back(state: WindowEntry, id: string): void {
    const entry = this.ownership.requireOwned(state, id)
    const history = entry.view.webContents.navigationHistory
    const targetIndex = this.navigationErrors.backTargetIndex(entry)
    if (targetIndex >= 0) history.goToIndex(targetIndex)
  }

  forward(state: WindowEntry, id: string): void {
    const history = this.ownership.requireOwned(state, id).view.webContents.navigationHistory
    if (history.canGoForward()) history.goForward()
  }

  reload(state: WindowEntry, id: string): void {
    const entry = this.ownership.requireOwned(state, id)
    if (entry.loadError && !entry.loadErrorRetryable) {
      this.navigationErrors.show(entry, entry.displayedUrl, entry.loadError, false)
    } else if (entry.loadError || entry.errorPageUrl) {
      this.navigationErrors.load(entry, entry.displayedUrl)
    }
    else entry.view.webContents.reload()
  }

  stop(state: WindowEntry, id: string): void {
    this.ownership.requireOwned(state, id).view.webContents.stop()
  }

  setBounds(state: WindowEntry, requested: ElectronRect): void {
    this.windowLifecycle.setBounds(state, requested)
  }

  setFullscreen(state: WindowEntry, fullscreen: boolean): void {
    this.windowLifecycle.setFullscreen(state, fullscreen)
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
    const entry = this.ownership.requireOwned(state, id)
    this.validatePoint(point)
    this.menus.showTabMenu(state, id, point, entry.hasPlayedAudio, entry.muted)
  }

  private detachedBounds(tabId: string | undefined, point: ElectronPoint): Rectangle {
    this.validatePoint(point)
    const entry = tabId ? this.ownership.get(tabId) : undefined
    const owner = entry ? this.ownership.ownerFor(entry) : undefined
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

  // Reader URLs reference documents we stored ourselves, so they skip the
  // HTTP-only normalization applied to other navigable input.
  private normalizeTabUrl(url: string): string {
    const trimmed = url.trim()
    return sourceUrlFromReaderUrl(trimmed) ? trimmed : normalizeBrowserUrl(trimmed)
  }

  private tryNormalizeUrl(url: string): string | null {
    if (!url) return null
    try {
      return normalizeBrowserUrl(url)
    } catch {
      return null
    }
  }

}
