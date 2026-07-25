import {
  InAppBrowserSurface
} from "@once/platform-mobile"
import {
  Menu,
  READING_REQUEST,
  ReaderDocumentHost,
  ReadingRequestEvent,
  ReadingSession,
  ReadingSessionState,
  StoryList,
  StoryListItem
} from "@once/ui-web"

export class MobileReadingController {
  readonly session = new ReadingSession()
  private readonly content: HTMLElement
  private activePanel = "stories"
  private removers: Array<() => void> = []
  private contentKey = ""

  constructor(
    private readonly surface: InAppBrowserSurface,
    private readonly reader: ReaderDocumentHost
  ) {
    this.content = required("#reading_content")
    this.bindControls()
    this.bindEvents()
    this.session.subscribe((state) => {
      this.render(state)
      void this.syncSurface(state)
    })
  }

  async install(): Promise<void> {
    const started = await this.surface.addListener(
      "navigationStarted",
      (event) => this.session.navigationStarted(event.navigationId, event.url)
    )
    const committed = await this.surface.addListener(
      "navigationCommitted",
      (event) => this.session.navigationCommitted(event.navigationId, event.url)
    )
    const finished = await this.surface.addListener(
      "navigationFinished",
      (event) => this.session.navigationFinished(event.navigationId, event.url)
    )
    const failed = await this.surface.addListener(
      "navigationFailed",
      (event) => this.session.navigationFailed(
        event.navigationId,
        event.url,
        event.message
      )
    )
    const history = await this.surface.addListener(
      "historyChanged",
      (event) => this.session.historyChanged(
        event.navigationId,
        event.url,
        event.canGoBack
      )
    )
    this.removers.push(started, committed, finished, failed, history)
  }

  async openReaderDocument(html: string, sourceUrl: string): Promise<void> {
    const state = this.session.snapshot()
    if (state.mode !== "reader" || state.story?.href !== sourceUrl) return
    await this.surface.setVisible(false)
    await this.reader.open(html)
  }

  async handleBack(): Promise<boolean> {
    const state = this.session.snapshot()
    if (!state.story) return false
    if (state.mode !== "reader" && state.canGoBack) {
      await this.surface.goBack()
      return true
    }
    this.close()
    return true
  }

  close(): void {
    this.reader.close()
    this.session.close()
    Menu.open_panel("stories")
    void this.surface.setVisible(false)
  }

  private bindEvents(): void {
    document.body.addEventListener(READING_REQUEST, (rawEvent) => {
      const event = rawEvent as ReadingRequestEvent
      event.preventDefault()
      this.session.setVisibleStories(StoryList.visibleStories())
      // Panel selection is synchronous: expose and lay out #reading_content
      // before session.open publishes the state that measures its bounds.
      this.activePanel = "reading"
      Menu.open_panel("reading")
      this.session.open(event.story, event.mode)
    })
    document.addEventListener("once-panel-changed", (rawEvent) => {
      const event = rawEvent as CustomEvent<{ panel: string }>
      this.activePanel = event.detail.panel
      void this.updateVisibility()
    })
    window.addEventListener("resize", () => void this.updateBounds())
    window.visualViewport?.addEventListener(
      "resize",
      () => void this.updateBounds()
    )
  }

  private bindControls(): void {
    required<HTMLButtonElement>("#reading_back").onclick = () => this.close()
    required<HTMLButtonElement>("#reading_previous").onclick = () => {
      this.session.setVisibleStories(StoryList.visibleStories())
      this.session.move(-1)
    }
    required<HTMLButtonElement>("#reading_next").onclick = () => {
      this.session.setVisibleStories(StoryList.visibleStories())
      this.session.move(1)
    }
    required<HTMLButtonElement>("#reading_comments").onclick = () =>
      this.session.setMode("comments")
    required<HTMLButtonElement>("#reading_reader_toggle").onclick = () =>
      this.session.setMode(
        this.session.snapshot().mode === "reader" ? "browser" : "reader"
      )
    required<HTMLButtonElement>("#reading_reload").onclick = () => {
      if (this.session.snapshot().mode === "reader") {
        this.session.setMode("reader")
      } else {
        void this.surface.reload()
      }
    }
    required<HTMLButtonElement>("#reading_story_menu").onclick = (event) => {
      const story = this.storyElement()
      if (story) story.requestMenu(event.currentTarget as HTMLElement)
    }
  }

  private storyElement(): StoryListItem | null {
    const href = this.session.snapshot().story?.href
    if (!href) return null
    return Array.from(document.querySelectorAll<StoryListItem>("story-item"))
      .find((row) => row.story.href === href) ?? null
  }

  private async syncSurface(state: Readonly<ReadingSessionState>): Promise<void> {
    if (!state.story) {
      this.contentKey = ""
      await this.surface.setVisible(false)
      return
    }
    const nextContentKey = `${state.story.href}\n${state.mode}`
    if (nextContentKey === this.contentKey) {
      await this.updateVisibility()
      return
    }
    this.contentKey = nextContentKey
    if (state.mode === "reader") {
      await this.surface.setVisible(false)
      this.reader.close()
      // ReaderView owns fetching/extraction and calls openReaderDocument.
      const { ReaderView } = await import("@once/ui-web")
      await ReaderView.open(state.story.href)
      return
    }
    this.reader.close()
    const bounds = this.bounds()
    await this.surface.open({
      url: state.currentUrl,
      bounds,
      visible: this.activePanel === "reading"
    })
    document.body.classList.toggle(
      "once-native-reading-surface",
      this.surface.available
    )
  }

  private async updateBounds(): Promise<void> {
    if (!this.session.snapshot().story) return
    await this.surface.setBounds(this.bounds())
  }

  private async updateVisibility(): Promise<void> {
    const state = this.session.snapshot()
    await this.surface.setVisible(
      this.activePanel === "reading" &&
      state.story != null &&
      state.mode !== "reader"
    )
  }

  private bounds() {
    const rect = this.content.getBoundingClientRect()
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
  }

  private render(state: Readonly<ReadingSessionState>): void {
    const story = state.story
    // Keep the native navigation state observable from the Capacitor shell.
    // Besides driving styling/debugging, this gives native acceptance tests a
    // stable contract that only becomes "ready" after the secondary WebView
    // reports navigationFinished.
    this.content.dataset.mode = state.mode
    this.content.dataset.loadState = state.loadState
    this.content.dataset.navigationId = String(state.navigationId)
    required("#reading_title").textContent = story?.title ?? "Reading"
    required("#reading_type").textContent = story ? `[${story.type}]` : ""
    required("#reading_domain").textContent = story
      ? `(${new URL(story.href).hostname})`
      : ""
    required("#reading_url").textContent = state.currentUrl
    required<HTMLButtonElement>("#reading_previous").disabled =
      state.visibleStoryIndex <= 0
    required<HTMLButtonElement>("#reading_next").disabled =
      state.visibleStoryIndex < 0 ||
      state.visibleStoryIndex >= StoryList.visibleStories().length - 1
    required("#reading_reader_toggle").classList.toggle(
      "active",
      state.mode === "reader"
    )
    const error = required("#reading_error")
    error.hidden = state.error == null
    error.textContent = state.error ?? ""
  }
}

function required<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing mobile Reading element: ${selector}`)
  return element
}
