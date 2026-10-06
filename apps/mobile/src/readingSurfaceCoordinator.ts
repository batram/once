import type { BrowserNavigationEvent, InAppBrowserSurface } from "@once/platform-mobile"
import type {
  ReaderDocumentHost,
  ReadingSession,
  ReadingSessionState
} from "@once/ui-web"
import type { HistoryDirection, HistoryEntry, ReadingHistory } from "./readingHistory"

export interface ReadingDocumentLoader {
  load(
    url: string,
    acceptDocument: (html: string, sourceUrl: string) => Promise<void>
  ): Promise<void>
}

const defaultDocumentLoader: ReadingDocumentLoader = {
  async load(url, acceptDocument) {
    const { ReaderView } = await import("@once/ui-web")
    await ReaderView.openWith(url, "_self", acceptDocument)
  }
}

export class ReadingSurfaceCoordinator {
  readonly session: ReadingSession
  private readonly surface: InAppBrowserSurface
  private readonly reader: ReaderDocumentHost
  private readonly content: HTMLElement
  private readonly documentLoader: ReadingDocumentLoader
  private disposed = false
  private readerLoaded = false
  private browserOpened = false
  private browserUrl = ""
  private browserReady = false
  private pendingNavigationUrl: string | null = null
  // A popup's page was already loading natively under its own (possibly redirected) URL.
  private adoptedUrl: string | null = null
  private readingPanelVisible = false
  private menuOpen = false
  private overlayOpen = false
  private dialogOpen = false
  private extensionPageOpen = false
  private surfaceGeneration = 0
  private surfaceKey: string | null = null
  private readerRequestId = 0
  private surfaceQueue: Promise<void> = Promise.resolve()
  private edgeSwipeHandler: ((direction: "back" | "forward") => void) | null = null
  private closeRequestedHandler: (() => void) | null = null
  private mediaStateHandler: ((playing: boolean) => void) | null = null
  private finishedHandler: ((event: BrowserNavigationEvent) => void) | null = null
  private publishedGestures = ""
  private readonly history: ReadingHistory | null

  constructor(
    session: ReadingSession,
    surface: InAppBrowserSurface,
    reader: ReaderDocumentHost,
    content: HTMLElement,
    documentLoader: ReadingDocumentLoader = defaultDocumentLoader,
    /** The tab's history; without one, Back and Forward are the engine's alone. */
    history: ReadingHistory | null = null
  ) {
    this.history = history
    this.session = session
    this.surface = surface
    this.reader = reader
    this.content = content
    this.documentLoader = documentLoader
    this.unsubscribe = this.session.subscribe((state) => {
      if (!state.currentUrl || state.mode === "reader") this.pendingNavigationUrl = null
      else if (state.loadState === "loading" && state.currentUrl !== this.browserUrl) {
        // Native events already in flight still carry the previous navigation
        // ID until the new page starts. Preserve the user's latest destination
        // across the asynchronous setBounds/navigate bridge calls.
        this.pendingNavigationUrl = state.currentUrl
      }
      // Story refreshes and history flags republish the session; only these
      // fields change what the native surface or reader should show.
      this.publishHistory()
      const surfaceKey = `${state.mode}\n${state.loadState}\n${state.currentUrl}`
      if (surfaceKey === this.surfaceKey) return
      this.surfaceKey = surfaceKey
      const generation = ++this.surfaceGeneration
      void this.enqueue(async () => {
        try {
          await this.syncSurface(state, generation)
        } catch (error) {
          // A native initialization rejection has no navigation event. Surface it
          // here instead of leaving the shell loading forever. A newer request
          // owns its own error state, even if this bridge call finishes late.
          if (generation !== this.surfaceGeneration || !state.currentUrl || state.mode === "reader" || state.loadState === "error") return
          this.pendingNavigationUrl = null
          this.browserReady = false
          this.session.navigationFailed(state.navigationId, state.currentUrl,
            error instanceof Error ? error.message : "The browser could not open this page.")
        }
      })
    })
  }

  private readonly unsubscribe: () => void

  /** `keepReader` leaves a shared reader usable by whoever owns it next. */
  dispose(keepReader = false): void {
    this.disposed = true
    this.unsubscribe()
    this.readerRequestId += 1
    this.surfaceGeneration += 1
    this.listenerRemovers.forEach(remove => remove())
    if (keepReader) { this.reader.close(); this.reader.setVisible(false) } else this.reader.destroy()
    void this.enqueue(() => this.surface.close())
  }

  private installation: Promise<void> | null = null

  install(): Promise<void> {
    this.installation ??= this.installListeners()
    return this.installation
  }

  private async installListeners(): Promise<void> {
    const started = await this.surface.addListener("navigationStarted", (event) => {
      if (this.readerShown()) { this.browserReady = false; return }
      if (!this.acceptsNavigation(event.navigationId, event.url, true)) return
      this.pendingNavigationUrl = null
      this.adoptedUrl = null
      this.browserUrl = event.url
      this.browserReady = false
      this.session.navigationStarted(event.navigationId, event.url, event)
    })
    const committed = await this.surface.addListener(
      "navigationCommitted",
      (event) => {
        if (this.readerShown()) { this.browserUrl = event.url; return }
        if (!this.acceptsNavigation(event.navigationId, event.url)) return
        this.browserUrl = event.url
        this.session.navigationCommitted(event.navigationId, event.url, undefined, event)
      }
    )
    const finished = await this.surface.addListener(
      "navigationFinished",
      (event) => {
        if (this.readerShown()) { this.browserUrl = event.url; this.browserReady = true; return }
        if (!this.acceptsNavigation(event.navigationId, event.url)) return
        this.browserUrl = event.url
        this.browserReady = true
        this.session.navigationFinished(event.navigationId, event.url, event)
        this.finishedHandler?.(event)
      }
    )
    const failed = await this.surface.addListener("navigationFailed", (event) => {
      if (this.readerShown()) { this.browserReady = false; return }
      if (!this.acceptsNavigation(event.navigationId, event.url, true)) return
      this.pendingNavigationUrl = null
      this.adoptedUrl = null
      this.browserReady = false
      this.session.navigationFailed(event.navigationId, event.url, event.message)
    })
    const history = await this.surface.addListener("historyChanged", (event) => {
      if (this.disposed) return
      if (this.history && event.historyUrls && typeof event.historyIndex === "number") {
        const moved = this.history.nativeReported(event.historyUrls, event.historyIndex)
        // The page went back or forward by itself, onto an entry read in Reader mode.
        if (moved?.reader) this.showEntry(moved, false)
        this.publishHistory()
      }
      if (this.readerShown()) return
      if (!this.acceptsNavigation(event.navigationId, event.url)) return
      this.browserUrl = event.url
      this.session.historyChanged(event.navigationId, event.url, event.canGoBack, event.canGoForward === true)
    })
    // The page's own edge swipes stay native; only the ones it cannot honour
    // (no history that way) arrive here for the shell to continue.
    const edge = await this.surface.addListener("edgeSwipe", (event) => {
      if (!this.browserOpened || !this.readingPanelVisible) return
      this.edgeSwipeHandler?.(event.direction)
    })
    const close = await this.surface.addListener("closeRequested", () => {
      if (this.browserOpened) this.closeRequestedHandler?.()
    })
    const media = await this.surface.addListener("mediaStateChanged", (event) => {
      this.mediaStateHandler?.(event.playing)
    })
    // Listener lifetimes match the application lifetime. Retaining the
    // removers makes ownership explicit and prevents premature collection in
    // native bridge implementations.
    if (this.disposed) [started, committed, finished, failed, history, edge, close, media].forEach(remove => remove())
    else this.listenerRemovers.push(started, committed, finished, failed, history, edge, close, media)
  }

  onEdgeSwipe(handler: (direction: "back" | "forward") => void): void {
    this.edgeSwipeHandler = handler
  }

  /** The page's own media (not reader speech) started or stopped playing. */
  onMediaStateChanged(handler: (playing: boolean) => void): void {
    this.mediaStateHandler = handler
  }

  onCloseRequested(handler: () => void): void {
    this.closeRequestedHandler = handler
  }

  /** Only finishes this coordinator accepted, so late events of an older page never reach it. */
  onNavigationFinished(handler: (event: BrowserNavigationEvent) => void): void {
    this.finishedHandler = handler
  }

  /**
   * The native page behind `url` started loading before this coordinator
   * listened; open() replays its current navigation, whose URL may already
   * be a redirect target, so that replay is accepted as this page's start.
   */
  adopt(url: string): void {
    this.adoptedUrl = url
  }

  private readonly listenerRemovers: Array<() => void> = []

  setReadingPanelVisible(visible: boolean): void {
    // Tab syncs repeat this for every tab; session changes resync on their own.
    if (visible === this.readingPanelVisible) return
    this.readingPanelVisible = visible
    this.reader.setVisible(visible && this.session.snapshot().mode === "reader")
    // A background tab opened while the panel was hidden, or before a
    // rotation, holds stale native bounds; only the shown tab tracks resizes.
    if (visible) {
      void this.enqueue(async () => {
        if (this.browserOpened) await this.surface.setBounds(this.bounds())
      })
    }
    void this.updateVisibility()
  }

  setMenuOpen(open: boolean): void {
    this.menuOpen = open
    void this.updateVisibility()
  }

  setOverlayOpen(open: boolean): void {
    this.overlayOpen = open
    void this.updateVisibility()
  }

  setDialogOpen(open: boolean): void {
    this.dialogOpen = open
    void this.updateVisibility()
  }

  /** An extension page is framed over the panel; its bar is shell DOM the surface would cover. */
  setExtensionPageOpen(open: boolean): void {
    this.extensionPageOpen = open
    void this.updateVisibility()
  }

  isBrowserReady(): boolean {
    return this.browserReady
  }

  isBrowserOpened(): boolean {
    return this.browserOpened
  }

  isAvailable(): boolean {
    return this.surface.available
  }

  closeReading(): void {
    this.reader.close()
    this.session.close()
  }

  canStep(direction: HistoryDirection): boolean {
    return this.history?.canStep(direction) ?? false
  }

  /**
   * One step through the tab's history, Reader-mode entries included. False
   * when there is nothing that way, so the caller decides what Back means then.
   */
  async stepHistory(direction: HistoryDirection): Promise<boolean> {
    const step = this.history?.step(direction)
    if (!step) return false
    this.showEntry(step.entry, step.nativeIndex === null)
    const index = step.nativeIndex
    if (index !== null) await this.enqueue(async () => { await this.surface.goToHistoryIndex?.(index) })
    this.publishHistory()
    return true
  }

  /** Shows an entry without loading anything new: the page is there or moving there. */
  private showEntry(entry: Readonly<HistoryEntry>, pageThere: boolean): void {
    if (entry.reader) {
      this.session.showHistoryEntry(entry.url, "reader")
      return
    }
    this.browserUrl = entry.url
    const story = this.session.snapshot().story
    const mode = story?.comment_url === entry.url ? "comments" : "browser"
    this.session.showHistoryEntry(entry.url, mode, pageThere && this.browserReady)
  }

  /** iOS: WebKit's own swipe may only take steps that are its pages here too. */
  private publishHistory(): void {
    if (this.disposed || !this.history || !this.surface.setHistoryGestures) return
    const gestures = { back: this.history.nativeMayStep("back"), forward: this.history.nativeMayStep("forward") }
    const key = `${gestures.back}/${gestures.forward}`
    if (key === this.publishedGestures) return
    this.publishedGestures = key
    void this.enqueue(async () => { await this.surface.setHistoryGestures?.(gestures) })
  }

  /** The hidden page behind a reader never changes what the session shows. */
  private readerShown(): boolean {
    return this.session.snapshot().mode === "reader"
  }

  async goBack(): Promise<void> {
    await this.enqueue(() => this.surface.goBack())
  }

  async goForward(): Promise<void> {
    await this.enqueue(() => this.surface.goForward())
  }

  async reload(): Promise<void> {
    if (!this.browserOpened || this.session.snapshot().loadState === "error") {
      // WebKit's reload can target the last committed page after an early failure.
      this.browserUrl = ""
      this.session.retry()
      return
    }
    await this.enqueue(() => this.surface.reload())
  }

  async updateBounds(): Promise<void> {
    if (!this.session.snapshot().currentUrl || !this.browserOpened) return
    await this.enqueue(() => this.surface.setBounds(this.bounds()))
  }

  private async syncSurface(
    state: Readonly<ReadingSessionState>,
    generation: number
  ): Promise<void> {
    if (this.installation) await this.installation
    if (state.currentUrl && state.loadState === "idle") return
    if (this.disposed || generation !== this.surfaceGeneration) return
    if (!state.currentUrl) {
      this.readerRequestId += 1
      this.reader.close()
      if (this.browserOpened) {
        // Closing retires a tab-scoped native identity for good; this one is
        // reused for the next address, so only dispose() closes it.
        await this.surface.setVisible(false)
        this.browserUrl = ""
        this.browserReady = false
      }
      return
    }
    if (state.mode === "reader") {
      await this.surface.setVisible(false)
      if (this.disposed || generation !== this.surfaceGeneration) return
      if (state.loadState !== "loading") {
        if (state.loadState === "error") this.reader.close()
        return
      }
      this.readerLoaded = false
      this.reader.close()
      const requestId = ++this.readerRequestId
      void this.loadReader(state.currentUrl, requestId)
      return
    }
    this.readerRequestId += 1
    if (this.readerLoaded) this.reader.setVisible(false)
    else this.reader.close()
    // Publishing a failed open must not queue another open automatically.
    // The next explicit navigation will put the session back into loading.
    if (state.loadState === "error") {
      if (this.browserOpened) await this.surface.setVisible(false)
      return
    }
    const bounds = this.bounds()
    if (!this.browserOpened) {
      // Set first: an adopted page replays its events while open() is pending.
      this.browserUrl = state.currentUrl
      this.browserReady = false
      await this.surface.open({
        url: state.currentUrl,
        bounds,
        visible: false
      })
      this.browserOpened = true
    } else {
      await this.surface.setBounds(bounds)
      if (this.disposed || generation !== this.surfaceGeneration) return
      if (this.browserUrl !== state.currentUrl) {
        this.browserUrl = state.currentUrl
        this.browserReady = false
        await this.surface.navigate(state.currentUrl)
      }
    }
    if (this.disposed || generation !== this.surfaceGeneration) return
    await this.surface.setVisible(this.readingPanelVisible && !this.menuOpen && !this.overlayOpen && !this.dialogOpen && !this.extensionPageOpen)
    document.body.classList.toggle(
      "once-native-reading-surface",
      this.surface.available
    )
  }

  private async updateVisibility(): Promise<void> {
    const state = this.session.snapshot()
    const visible = this.readingPanelVisible &&
      Boolean(state.currentUrl) &&
      state.loadState !== "error" &&
      state.mode !== "reader" &&
      !this.menuOpen && !this.overlayOpen && !this.dialogOpen && !this.extensionPageOpen
    await this.enqueue(async () => {
      if (!this.browserOpened) return
      await this.surface.setVisible(visible)
    })
  }

  private bounds() {
    const rect = this.content.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }

  private async loadReader(url: string, requestId: number): Promise<void> {
    try {
      await this.documentLoader.load(url, async (html, sourceUrl) => {
        if (!this.acceptsReaderRequest(requestId, sourceUrl)) return
        await this.reader.open(html)
        this.readerLoaded = true
        this.reader.setVisible(this.readingPanelVisible)
      })
      if (!this.acceptsReaderRequest(requestId, url)) return
      this.session.readerFinished(url)
    } catch (error) {
      if (!this.acceptsReaderRequest(requestId, url)) return
      this.reader.close()
      const message = error instanceof Error
        ? error.message
        : "Reader mode could not process this page."
      this.session.readerFailed(url, message)
    }
  }

  private acceptsReaderRequest(requestId: number, url: string): boolean {
    const state = this.session.snapshot()
    return !this.disposed && requestId === this.readerRequestId &&
      state.mode === "reader" &&
      state.currentUrl === url
  }

  private enqueue(operation: () => Promise<void>): Promise<void> {
    const queued = this.surfaceQueue.then(operation).catch((error) => {
      console.error("Reading browser surface operation failed", error)
    })
    this.surfaceQueue = queued
    return queued
  }

  private acceptsNavigation(navigationId: number, url: string, startsOrFails = false): boolean {
    const state = this.session.snapshot()
    if (this.disposed || !url) return false
    if (this.pendingNavigationUrl !== null) {
      if (!startsOrFails) return false
      if (this.pendingNavigationUrl === this.adoptedUrl) return navigationId >= state.navigationId
      try {
        if (new URL(url).href !== new URL(this.pendingNavigationUrl).href) return false
      } catch { if (url !== this.pendingNavigationUrl) return false }
    }
    return Boolean(state.story || state.currentUrl) &&
      navigationId >= state.navigationId
  }
}
