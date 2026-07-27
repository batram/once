import {
  InAppBrowserSurface,
  normalizeReadingUrl
} from "@once/platform-mobile"
import { humanTime } from "@once/core"
import { ReaderTtsUiControls } from "./readerTtsControls"
import {
  Menu,
  READING_REQUEST,
  ReaderDocumentHost,
  ReadingRequestEvent,
  ReadingSession,
  ReadingSessionState,
  Search,
  StoryList,
  StoryListItem,
  closeStoryAnchoredMenu,
  isStoryAnchoredMenuOpen
} from "@once/ui-web"

export class MobileReadingController {
  readonly session = new ReadingSession()
  private readonly content: HTMLElement
  private activePanel = "stories"
  private settingsReturnPanel: "stories" | "reading" = "stories"
  private removers: Array<() => void> = []
  private browserOpened = false
  private browserUrl = ""
  private browserReady = false
  private editingAddress = false
  private surfaceGeneration = 0
  private surfaceQueue: Promise<void> = Promise.resolve()

  constructor(
    private readonly surface: InAppBrowserSurface,
    private readonly reader: ReaderDocumentHost,
    private readonly ttsControls: ReaderTtsUiControls
  ) {
    this.content = required("#reading_content")
    this.bindControls()
    this.bindEvents()
    this.session.subscribe((state) => {
      this.render(state)
      const generation = ++this.surfaceGeneration
      void this.enqueueSurface(() => this.syncSurface(state, generation))
    })
  }

  async install(): Promise<void> {
    const started = await this.surface.addListener(
      "navigationStarted",
      (event) => {
        if (!this.acceptsNavigation(event.navigationId)) return
        this.browserUrl = event.url
        this.browserReady = false
        this.session.navigationStarted(event.navigationId, event.url)
      }
    )
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
    const failed = await this.surface.addListener(
      "navigationFailed",
      (event) => {
        if (!this.acceptsNavigation(event.navigationId)) return
        this.browserReady = false
        this.session.navigationFailed(
          event.navigationId,
          event.url,
          event.message
        )
      }
    )
    const history = await this.surface.addListener(
      "historyChanged",
      (event) => {
        if (!this.acceptsNavigation(event.navigationId)) return
        this.browserUrl = event.url
        this.session.historyChanged(
          event.navigationId,
          event.url,
          event.canGoBack
        )
      }
    )
    this.removers.push(started, committed, finished, failed, history)
  }

  async openReaderDocument(html: string, sourceUrl: string): Promise<void> {
    const state = this.session.snapshot()
    if (state.mode !== "reader" || state.currentUrl !== sourceUrl) return
    const generation = this.surfaceGeneration
    await this.enqueueSurface(() => this.surface.setVisible(false))
    const latest = this.session.snapshot()
    if (generation !== this.surfaceGeneration ||
        latest.mode !== "reader" ||
        latest.currentUrl !== sourceUrl) return
    await this.reader.open(html)
  }

  async handleBack(): Promise<boolean> {
    const dialog = document.querySelector<HTMLDialogElement>("dialog[open]")
    if (dialog) {
      dialog.close()
      return true
    }

    if (isStoryAnchoredMenuOpen()) {
      closeStoryAnchoredMenu()
      return true
    }

    if (this.activePanel === "settings") {
      const settingsPanel = document.querySelector<HTMLElement>("#settings_panel")
      if (settingsPanel?.classList.contains("settings_detail_open")) {
        document.querySelector<HTMLButtonElement>("#settings_section_back")?.click()
        return true
      }
      Menu.open_panel(this.settingsReturnPanel)
      return true
    }

    if (this.activePanel === "stories") {
      const searchfield = required<HTMLInputElement>("#searchfield")
      if (searchfield.value !== "") {
        await Search.searchStories("")
        searchfield.blur()
        return true
      }
      if (document.activeElement === searchfield) {
        searchfield.blur()
        return true
      }
      return false
    }

    if (this.editingAddress) {
      const address = required<HTMLInputElement>("#reading_url")
      this.editingAddress = false
      address.value = this.session.snapshot().currentUrl
      address.blur()
      this.clearValidation()
      this.renderAddressAction()
      return true
    }

    const state = this.session.snapshot()
    if (!state.story && !state.currentUrl) {
      Menu.open_panel("stories")
      return true
    }
    if (state.mode !== "reader" && state.canGoBack) {
      await this.enqueueSurface(() => this.surface.goBack())
      return true
    }
    this.close()
    return true
  }

  close(): void {
    this.clearReading()
    Menu.open_panel("stories")
  }

  private clearReading(): void {
    this.ttsControls.dismiss()
    this.reader.close()
    this.session.close()
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
      const nextPanel = event.detail.panel
      if (nextPanel === "settings" && this.activePanel !== "settings") {
        this.settingsReturnPanel = this.activePanel === "reading"
          ? "reading"
          : "stories"
      }
      this.activePanel = nextPanel
      const state = this.session.snapshot()
      this.ttsControls.setReaderMode(
        this.activePanel === "reading" &&
        state.mode === "reader" &&
        Boolean(state.currentUrl)
      )
      void this.updateVisibility()
    })
    window.addEventListener("resize", () => void this.updateBounds())
    window.visualViewport?.addEventListener(
      "resize",
      () => void this.updateBounds()
    )
    // The native browser is a sibling view, so it does not follow DOM flex
    // layout automatically. Keep its rectangle synchronized when the current
    // story row appears or collapses.
    new ResizeObserver(() => void this.updateBounds()).observe(this.content)
  }

  private bindControls(): void {
    const address = required<HTMLInputElement>("#reading_url")
    const form = required<HTMLFormElement>("#reading_url_form")
    required<HTMLAnchorElement>("#reading_title").onclick = (event) => {
      event.preventDefault()
      void this.openStoryContent()
    }
    required<HTMLButtonElement>("#reading_comments").onclick = () => {
      void this.openComments()
    }
    required<HTMLButtonElement>("#reading_reader_toggle").onclick = () => {
      this.editingAddress = false
      address.value = this.session.snapshot().currentUrl
      this.session.setMode(
        this.session.snapshot().mode === "reader" ? "browser" : "reader",
        this.browserReady
      )
    }
    address.addEventListener("focus", () => {
      this.editingAddress = true
      this.renderAddressAction()
    })
    address.addEventListener("input", () => {
      this.clearValidation()
      this.renderAddressAction()
    })
    address.addEventListener("blur", (event) => {
      if (form.contains(event.relatedTarget as Node | null)) return
      this.editingAddress = false
      address.value = this.session.snapshot().currentUrl
      this.renderAddressAction()
    })
    address.addEventListener("keydown", (event) => {
      if (event.key !== "Escape") return
      address.value = this.session.snapshot().currentUrl
      address.blur()
    })
    form.addEventListener("submit", (event) => {
      event.preventDefault()
      void this.submitAddress()
    })
    required<HTMLButtonElement>("#reading_story_menu").onclick = async (event) => {
      const story = this.storyElement()
      if (!story) return
      const anchor = event.currentTarget as HTMLElement
      await this.enqueueSurface(() => this.surface.setVisible(false))
      story.requestMenu(anchor)
    }
    document.addEventListener("once-story-menu-closed", () => {
      void this.updateVisibility()
    })
  }

  private storyElement(): StoryListItem | null {
    const href = this.session.snapshot().story?.href
    if (!href) return null
    return Array.from(document.querySelectorAll<StoryListItem>("story-item"))
      .find((row) => row.story.href === href) ?? null
  }

  private async syncSurface(
    state: Readonly<ReadingSessionState>,
    generation: number
  ): Promise<void> {
    if (generation !== this.surfaceGeneration) return
    if (!state.currentUrl) {
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
      this.reader.close()
      // ReaderView owns fetching/extraction and calls openReaderDocument.
      void import("@once/ui-web").then(({ ReaderView }) =>
        ReaderView.open(state.currentUrl)
      ).catch((error) => {
        console.error("Failed to open Reader mode", error)
      })
      return
    }
    this.reader.close()
    const bounds = this.bounds()
    if (!this.browserOpened) {
      await this.surface.open({
        url: state.currentUrl,
        bounds,
        // Never let an older open cover a newer Reader transition.
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
    await this.surface.setVisible(this.activePanel === "reading")
    document.body.classList.toggle(
      "once-native-reading-surface",
      this.surface.available
    )
  }

  private async updateBounds(): Promise<void> {
    if (!this.session.snapshot().currentUrl || !this.browserOpened) return
    const bounds = this.bounds()
    await this.enqueueSurface(() => this.surface.setBounds(bounds))
  }

  private async updateVisibility(): Promise<void> {
    const state = this.session.snapshot()
    const visible = this.activePanel === "reading" &&
      Boolean(state.currentUrl) &&
      state.mode !== "reader"
    await this.enqueueSurface(async () => {
      if (!this.browserOpened) return
      await this.surface.setVisible(visible)
    })
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
    required("#reading_empty").hidden = state.currentUrl !== ""
    const isStoryPage = story != null &&
      (state.currentUrl === story.href || state.currentUrl === story.comment_url)
    const matchingStory = isStoryPage ? this.storyElement() : null
    const currentCard = required("#reading_current_card")
    currentCard.hidden = matchingStory == null
    const title = required<HTMLAnchorElement>("#reading_title")
    title.textContent = story?.title ?? "Reading"
    title.href = story?.href ?? ""
    required("#reading_type").textContent = story?.type ?? ""
    required("#reading_story_time").textContent =
      story ? humanTime(story.timestamp) : ""
    required("#reading_story_meta").dataset.type =
      story ? `[${story.type}]` : ""
    required("#reading_story_menu").dataset.type =
      story ? `[${story.type}]` : ""
    this.renderStoryTags(story?.tags ?? [])
    const address = required<HTMLInputElement>("#reading_url")
    if (!this.editingAddress) address.value = state.currentUrl
    required("#reading_reader_toggle").classList.toggle(
      "active",
      state.mode === "reader"
    )
    required<HTMLButtonElement>("#reading_comments").hidden =
      matchingStory == null || !story?.comment_url
    required<HTMLButtonElement>("#reading_tts_start").hidden =
      state.mode !== "reader" ||
      !required<HTMLDivElement>("#reader_tts_pill").hidden
    this.ttsControls.setReaderMode(
      this.activePanel === "reading" &&
      state.mode === "reader" &&
      Boolean(state.currentUrl)
    )
    this.renderAddressAction()
    const error = required("#reading_error")
    error.hidden = state.error == null
    error.textContent = state.error ?? ""
  }

  private renderStoryTags(tags: Array<{
    class: string
    text: string
    href?: string
    icon?: string
  }>): void {
    const container = required("#reading_story_tags")
    container.replaceChildren()
    for (const tag of tags) {
      const element = document.createElement("span")
      element.classList.add("tag", `tag_${tag.class}`)
      element.textContent = tag.text
      if (tag.icon) {
        element.style.background = `url(${tag.icon}) left top / 13px no-repeat`
        element.style.paddingLeft = "17px"
      }
      container.append(element)
    }
  }

  private async submitAddress(): Promise<void> {
    const state = this.session.snapshot()
    const input = required<HTMLInputElement>("#reading_url")
    const normalized = normalizeReadingUrl(input.value)
    if (!normalized.ok) {
      const validation = required("#reading_url_validation")
      validation.textContent = normalized.error
      validation.hidden = false
      input.focus()
      return
    }
    this.clearValidation()
    if (normalized.url === state.currentUrl && state.mode !== "reader") {
      if (state.loadState !== "loading") {
        await this.enqueueSurface(() => this.surface.reload())
      }
      return
    }
    input.value = normalized.url
    this.editingAddress = false
    this.session.navigate(normalized.url)
    input.blur()
  }

  private async openComments(): Promise<void> {
    const state = this.session.snapshot()
    const commentsUrl = state.story?.comment_url
    if (!commentsUrl) return
    if (state.mode === "comments" && state.currentUrl === commentsUrl) {
      if (this.browserOpened && state.loadState !== "loading") {
        await this.enqueueSurface(() => this.surface.reload())
      }
      return
    }

    this.session.setMode("comments")
  }

  private async openStoryContent(): Promise<void> {
    const state = this.session.snapshot()
    const storyUrl = state.story?.href
    if (!storyUrl) return
    if (state.mode === "browser" && state.currentUrl === storyUrl) {
      if (this.browserOpened && state.loadState !== "loading") {
        await this.enqueueSurface(() => this.surface.reload())
      }
      return
    }

    this.session.navigate(storyUrl)
  }

  private clearValidation(): void {
    const validation = required("#reading_url_validation")
    validation.textContent = ""
    validation.hidden = true
  }

  private renderAddressAction(): void {
    const state = this.session.snapshot()
    const input = required<HTMLInputElement>("#reading_url")
    const action = required<HTMLButtonElement>("#reading_navigate")
    const changed = input.value.trim() !== state.currentUrl
    action.textContent = changed ? "Go" : "↻"
    action.setAttribute("aria-label", changed ? "Go to address" : "Reload")
    action.disabled = state.loadState === "loading" && !changed
  }

  private enqueueSurface(operation: () => Promise<void>): Promise<void> {
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


function required<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing mobile Reading element: ${selector}`)
  return element
}
