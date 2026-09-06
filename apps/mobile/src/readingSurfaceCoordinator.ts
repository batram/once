import type { InAppBrowserSurface } from "@once/platform-mobile"
import type {
  ReaderDocumentHost,
  ReadingSession,
  ReadingSessionState
} from "@once/ui-web"

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
  private browserOpened = false
  private browserUrl = ""
  private browserReady = false
  private readingPanelVisible = false
  private menuOpen = false
  private overlayOpen = false
  private surfaceGeneration = 0
  private readerRequestId = 0
  private surfaceQueue: Promise<void> = Promise.resolve()

  constructor(
    session: ReadingSession,
    surface: InAppBrowserSurface,
    reader: ReaderDocumentHost,
    content: HTMLElement,
    documentLoader: ReadingDocumentLoader = defaultDocumentLoader
  ) {
    this.session = session
    this.surface = surface
    this.reader = reader
    this.content = content
    this.documentLoader = documentLoader
    this.session.subscribe((state) => {
      const generation = ++this.surfaceGeneration
      void this.enqueue(() => this.syncSurface(state, generation))
    })
  }

  async install(): Promise<void> {
    const started = await this.surface.addListener("navigationStarted", (event) => {
      if (!this.acceptsNavigation(event.navigationId)) return
      this.browserUrl = event.url
      this.browserReady = false
      this.session.navigationStarted(event.navigationId, event.url)
    })
    const committed = await this.surface.addListener(
      "navigationCommitted",
      (event) => {
        if (!this.acceptsNavigation(event.navigationId)) return
        this.browserUrl = event.url
        this.session.navigationCommitted(event.navigationId, event.url)
      }
    )
    const finished = await this.surface.addListener(
      "navigationFinished",
      (event) => {
        if (!this.acceptsNavigation(event.navigationId)) return
        this.browserUrl = event.url
        this.browserReady = true
        this.session.navigationFinished(event.navigationId, event.url)
      }
    )
    const failed = await this.surface.addListener("navigationFailed", (event) => {
      if (!this.acceptsNavigation(event.navigationId)) return
      this.browserReady = false
      this.session.navigationFailed(event.navigationId, event.url, event.message)
    })
    const history = await this.surface.addListener("historyChanged", (event) => {
      if (!this.acceptsNavigation(event.navigationId)) return
      this.browserUrl = event.url
      this.session.historyChanged(event.navigationId, event.url, event.canGoBack)
    })
    // Listener lifetimes match the application lifetime. Retaining the
    // removers makes ownership explicit and prevents premature collection in
    // native bridge implementations.
    this.listenerRemovers.push(started, committed, finished, failed, history)
  }

  private readonly listenerRemovers: Array<() => void> = []

  setReadingPanelVisible(visible: boolean): void {
    this.readingPanelVisible = visible
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

  async goBack(): Promise<void> {
    await this.enqueue(() => this.surface.goBack())
  }

  async reload(): Promise<void> {
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
    if (generation !== this.surfaceGeneration) return
    if (!state.currentUrl) {
      this.readerRequestId += 1
      this.reader.close()
      if (this.browserOpened) {
        await this.surface.close()
        this.browserOpened = false
        this.browserUrl = ""
        this.browserReady = false
      }
      return
    }
    if (state.mode === "reader") {
      await this.surface.setVisible(false)
      if (generation !== this.surfaceGeneration) return
      if (state.loadState !== "loading") {
        if (state.loadState === "error") this.reader.close()
        return
      }
      this.reader.close()
      const requestId = ++this.readerRequestId
      void this.loadReader(state.currentUrl, requestId)
      return
    }
    this.readerRequestId += 1
    this.reader.close()
    const bounds = this.bounds()
    if (!this.browserOpened) {
      await this.surface.open({
        url: state.currentUrl,
        bounds,
        visible: false
      })
      this.browserOpened = true
      this.browserUrl = state.currentUrl
      this.browserReady = false
    } else {
      await this.surface.setBounds(bounds)
      if (generation !== this.surfaceGeneration) return
      if (this.browserUrl !== state.currentUrl) {
        this.browserUrl = state.currentUrl
        this.browserReady = false
        await this.surface.navigate(state.currentUrl)
      }
    }
    if (generation !== this.surfaceGeneration) return
    await this.surface.setVisible(this.readingPanelVisible && !this.menuOpen && !this.overlayOpen)
    document.body.classList.toggle(
      "once-native-reading-surface",
      this.surface.available
    )
  }

  private async updateVisibility(): Promise<void> {
    const state = this.session.snapshot()
    const visible = this.readingPanelVisible &&
      Boolean(state.currentUrl) &&
      state.mode !== "reader" &&
      !this.menuOpen && !this.overlayOpen
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
    return requestId === this.readerRequestId &&
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

  private acceptsNavigation(navigationId: number): boolean {
    const state = this.session.snapshot()
    return Boolean(state.story || state.currentUrl) &&
      navigationId >= state.navigationId
  }
}
