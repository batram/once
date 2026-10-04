import { StoryCardCollapse, renderStoryTags } from "./readingStoryCard"
import { InAppBrowserSurface, normalizeReadingUrl } from "@once/platform-mobile"
import { humanTime, URLRedirect, storyPageUrls } from "@once/core"
import { ReaderTtsUiControls } from "./readerTtsControls"
import {
  PanelNavigation,
  READING_REQUEST,
  ReadingRequestEvent,
  ReadingSession,
  ReadingSessionState,
  StorySearch,
  StoryList,
  StoryListItem,
  closeStoryAnchoredMenu,
  isStoryAnchoredMenuOpen
} from "@once/ui-web"
import { ReaderDocumentHost } from "@once/ui-web"
import { ReadingAddonTrays } from "./readingAddonTrays"
import { ReadingTabs, type ReadingTab } from "./readingTabs"
import { ReadingTabRuntime } from "./readingTabRuntime"
import { ReadingTabDialog } from "./readingTabDialog"
import { ReadingFindBar } from "./readingFindBar"
import { ReadingSurfaceCoordinator } from "./readingSurfaceCoordinator"
import { clearAddress, installAddressMenu } from "./addressMenu"

export class MobileReadingController {
  readonly session: ReadingSession
  readonly tabs = new ReadingTabs()
  private readonly runtime: ReadingTabRuntime
  private readonly tabDialog: ReadingTabDialog
  private readonly addonTrays: ReadingAddonTrays
  private readonly content: HTMLElement
  private get nativeReading(): ReadingSurfaceCoordinator { return this.runtime.coordinator }
  get reader(): ReaderDocumentHost { return this.runtime.reader }
  private readonly findBar: ReadingFindBar
  private activePanel = "stories"
  private settingsReturnPanel: "stories" | "reading" = "stories"
  private editingAddress = false
  private renderedNavigationId = 0
  private currentStoryRow: StoryListItem | null = null
  private readonly storyCollapse = new StoryCardCollapse(() => void this.nativeReading.updateBounds())
  // Which tab last rendered in Reader mode; leaving it in that same tab stops its speech.
  private readerModeTab: ReadingTab | null = null

  /**
   * The selected tab's own page once its current navigation has settled. A
   * restored tab has no runtime until the panel shows it, and that runtime
   * reloads the page; anything injected before then would be wiped.
   */
  async loadedBrowserPage(): Promise<{ surface: InAppBrowserSurface; url: string }> {
    const tab = this.ensureCurrentTab()
    PanelNavigation.open_panel("reading")
    if (tab.session.snapshot().mode === "reader") tab.session.setMode("browser", this.nativeReading.isBrowserReady())
    const state = await new Promise<Readonly<ReadingSessionState>>((resolve, reject) => {
      let settled = false
      const remove = tab.session.subscribe(next => {
        if (settled || next.mode === "reader" || next.loadState === "idle" || next.loadState === "loading") return
        settled = true
        // subscribe() reports synchronously, before `remove` exists.
        queueMicrotask(() => remove())
        if (next.loadState === "error") reject(new Error(`The page could not be loaded: ${next.error ?? next.currentUrl}`))
        else resolve(next)
      })
    })
    if (this.tabs.selected !== tab) throw new Error("The tab changed before its page loaded")
    return { surface: this.runtime.pageSurface, url: state.currentUrl }
  }

  runtimeReaderWindow(source: unknown): boolean {
    return this.runtime.isReaderWindow(source)
  }

  /** What system media controls show for a speaking reader. */
  describeReader(source: unknown): { title: string; subtitle: string } {
    const tab = this.runtime.tabForReaderWindow(source)
    const state = tab?.session.snapshot()
    let site = ""
    try { site = new URL(state?.currentUrl ?? "").hostname.replace(/^www\./, "") } catch { /* no page */ }
    return { title: tab?.title || state?.story?.title || site || "Article", subtitle: site }
  }

  setReaderAudible(source: unknown, audible: boolean): void {
    this.runtime.setReaderAudible(source, audible)
  }

  onReaderClosed(listener: (reader: ReaderDocumentHost) => void): void {
    this.runtime.onReaderClosed(listener)
  }

  openBrowserUrl(url: string): void {
    PanelNavigation.open_panel("reading")
    this.ensureCurrentTab()
    this.session.navigate(url)
  }

  constructor(
    private readonly surface: InAppBrowserSurface,
    initialReader: ReaderDocumentHost,
    private readonly ttsControls: ReaderTtsUiControls
  ) {
    this.content = required("#reading_content")
    this.runtime = new ReadingTabRuntime(this.tabs, surface, initialReader, this.content,
      () => {
        this.findBar.close()
        this.addonTrays.close()
        closeStoryAnchoredMenu()
        this.ttsControls.tabChanged()
        this.editingAddress = false
      },
      direction => { void (direction === "back" ? this.handleBack() : this.handleForward()) },
      message => this.tabDialog.announce(message))
    this.addonTrays = new ReadingAddonTrays(this.content, open => this.runtime.setCovered("overlay", open))
    this.session = this.runtime.session
    const readerProxy = new Proxy(initialReader, { get: (_target, property) => {
      const value = Reflect.get(this.reader, property)
      return typeof value === "function" ? value.bind(this.reader) : value
    } })
    this.findBar = new ReadingFindBar(surface, readerProxy, this.session, () => this.runtime.pageSurface)
    this.tabDialog = new ReadingTabDialog(this.tabs, {
      preview: () => this.runtime.capturePreview(),
      select: id => { this.tabs.select(id); PanelNavigation.open_panel("reading") },
      create: () => { this.tabs.create(); PanelNavigation.open_panel("reading"); required<HTMLInputElement>("#reading_url").focus() }
    })
    this.bindControls()
    this.bindEvents()
    this.nativeReading.onEdgeSwipe((direction) => {
      void (direction === "back" ? this.handleBack() : this.handleForward())
    })
    this.session.subscribe((state) => {
      this.render(state)
    })
    this.runtime.start()
  }

  async install(): Promise<void> {
    await this.surface.addListener("newTabRequested", event => {
      const tab = this.tabs.create(true, event.tabId, event.generation)
      PanelNavigation.open_panel("reading")
      tab.session.navigate(event.url)
      this.runtime.adopt(tab.id, event.url)
    })
  }

  setExtensionPageOpen(open: boolean): void {
    this.runtime.setCovered("extensionPage", open)
  }

  async handleBack(): Promise<boolean> {
    const dialog = Array.from(document.querySelectorAll<HTMLDialogElement>("dialog[open]")).at(-1)
    if (dialog) {
      dialog.close()
      return true
    }

    if (isStoryAnchoredMenuOpen()) {
      closeStoryAnchoredMenu()
      return true
    }

    if (this.activePanel === "reading" && this.addonTrays.close()) return true
    if (this.activePanel === "reading" && this.findBar.close()) return true

    if (this.activePanel === "settings") {
      // The same step the desktop mouse button takes, so the visit it leaves
      // stays reachable by Forward; the header chevron alone would drop it.
      if (this.settingsNavigate("back")) return true
      const settingsPanel = document.querySelector<HTMLElement>("#settings_panel")
      if (settingsPanel?.classList.contains("settings_detail_open")) {
        document.querySelector<HTMLButtonElement>("#settings_section_back")?.click()
        return true
      }
      PanelNavigation.open_panel(this.settingsReturnPanel)
      return true
    }

    if (this.activePanel === "stories") {
      const searchfield = required<HTMLInputElement>("#searchfield")
      if (searchfield.value !== "") {
        await StorySearch.searchStories("")
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
      PanelNavigation.open_panel("stories")
      return true
    }
    if (state.mode !== "reader" && state.canGoBack) {
      await this.nativeReading.goBack()
      return true
    }
    this.close()
    return true
  }

  /**
   * The forward half of the back stack. Settings keeps its own visit history
   * and answers the same event the desktop mouse button sends, including the
   * return to Settings after Back left it; otherwise only the browser page
   * has somewhere to go.
   */
  async handleForward(): Promise<boolean> {
    if (this.settingsNavigate("forward")) return true
    if (this.activePanel !== "reading") return false
    const state = this.session.snapshot()
    if (state.mode === "reader" || !state.canGoForward) return false
    await this.nativeReading.goForward()
    return true
  }

  /** Offers the step to the settings visit history; true when it took it. */
  private settingsNavigate(direction: "back" | "forward"): boolean {
    const navigation = new CustomEvent("once-settings-navigate", {
      cancelable: true,
      detail: { direction }
    })
    document.dispatchEvent(navigation)
    return navigation.defaultPrevented
  }

  close(): void {
    this.findBar.close()
    this.ttsControls.dismiss()
    PanelNavigation.open_panel("stories")
  }

  private ensureCurrentTab(): ReadingTab {
    return this.tabs.selected ?? this.tabs.create()
  }

  private bindEvents(): void {
    // Native browser views sit above the webview, including its modal dialogs.
    let dialogOpen = false
    new MutationObserver(() => {
      const open = Boolean(document.querySelector("dialog[open]"))
      if (open === dialogOpen) return
      dialogOpen = open
      this.runtime.setCovered("dialog", open)
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] })
    document.body.addEventListener(READING_REQUEST, (rawEvent) => {
      const event = rawEvent as ReadingRequestEvent
      event.preventDefault()
      this.tabs.refreshStories(StoryList.visibleStories())
      if (event.disposition === "new-background") {
        const tab = this.tabs.create(false)
        tab.session.open(event.story, event.mode, event.url)
        this.tabDialog.announce("Opened in background tab")
        return
      }
      if (event.disposition === "new-foreground") this.tabs.create()
      else this.ensureCurrentTab()
      // Panel selection is synchronous: expose and lay out #reading_content
      // before session.open publishes the state that measures its bounds.
      this.activePanel = "reading"
      PanelNavigation.open_panel("reading")
      this.session.open(event.story, event.mode, event.url)
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
      this.runtime.setPanelVisible(nextPanel === "reading")
      const state = this.session.snapshot()
      this.ttsControls.setReaderMode(
        this.activePanel === "reading" &&
        state.mode === "reader" &&
        state.loadState === "ready" &&
        Boolean(state.currentUrl)
      )
      this.nativeReading.setReadingPanelVisible(
        this.activePanel === "reading"
      )
    })
    window.addEventListener("resize", () => void this.nativeReading.updateBounds())
    window.visualViewport?.addEventListener(
      "resize",
      () => void this.nativeReading.updateBounds()
    )
    // The native browser is a sibling view, so it does not follow DOM flex
    // layout automatically. Keep its rectangle synchronized when the current
    // story row appears or collapses.
    new ResizeObserver(() => void this.nativeReading.updateBounds())
      .observe(this.content)
  }

  private bindControls(): void {
    const address = required<HTMLInputElement>("#reading_url")
    const form = required<HTMLFormElement>("#reading_url_form")
    const currentCard = required("#reading_current_card")
    required<HTMLAnchorElement>("#reading_title").onclick = (event) => {
      event.preventDefault()
      void this.toggleStoryAndComments()
    }
    required<HTMLButtonElement>("#reading_comments").onclick = () => {
      void this.openComments()
    }
    const sourceTag = required("#reading_type")
    sourceTag.onclick = () => void this.toggleStoryAndComments()
    sourceTag.onkeydown = (event) => {
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      void this.toggleStoryAndComments()
    }
    this.storyCollapse.bind(currentCard)
    required<HTMLButtonElement>("#reading_reader_toggle").onclick = () => {
      this.editingAddress = false
      address.value = this.session.snapshot().currentUrl
      this.session.setMode(
        this.session.snapshot().mode === "reader" ? "browser" : "reader",
        this.nativeReading.isBrowserReady()
      )
    }
    required<HTMLButtonElement>("#reading_reader_retry").onclick = () => {
      const state = this.session.snapshot()
      if (state.mode !== "reader" || !state.currentUrl) return
      this.session.retry()
    }
    required<HTMLButtonElement>("#reading_browser_retry").onclick = () => {
      void this.nativeReading.reload()
    }
    required<HTMLButtonElement>("#reading_browser_edit_address").onclick = () => {
      address.focus()
      address.select()
    }
    required<HTMLButtonElement>("#reading_reader_open_page").onclick = () => {
      const state = this.session.snapshot()
      if (!state.currentUrl) return
      this.session.setMode("browser", this.nativeReading.isBrowserReady())
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
    const clear = required<HTMLButtonElement>("#reading_url_clear")
    // A tap would blur the field first, which restores the page address and
    // hides this button before its click. Handling the touch itself keeps the
    // field focused and the keyboard up; WebKit ignores pointerdown here.
    clear.addEventListener("pointerdown", event => event.preventDefault())
    clear.addEventListener("touchend", (event) => {
      event.preventDefault()
      clearAddress(address)
    })
    clear.onclick = () => clearAddress(address)
    installAddressMenu(address, {
      go: (text) => {
        PanelNavigation.open_panel("reading")
        address.value = text
        void this.submitAddress()
      },
      clear: () => clearAddress(address)
    })
    required<HTMLButtonElement>("#reading_story_menu").onclick = (event) => {
      const story = this.storyElement()
      if (!story) return
      const anchor = event.currentTarget as HTMLElement
      if (!this.nativeReading.isAvailable()) {
        this.runtime.setCovered("menu", true)
      }
      story.requestMenu(anchor)
    }
    document.addEventListener("once-story-menu-closed", () => {
      // The anchored menu closes before it executes its action. Refresh on the
      // next microtask so synchronous changes such as bookmarking are visible.
      queueMicrotask(() => this.render(this.session.snapshot()))
      this.runtime.setCovered("menu", false)
    })
  }

  private storyElement(): StoryListItem | null {
    const href = this.session.snapshot().story?.href
    if (!href) return null
    return Array.from(document.querySelectorAll<StoryListItem>("story-item"))
      .find((row) => row.story.href === href) ?? null
  }

  private observeCurrentStory(row: StoryListItem | null): void {
    if (this.currentStoryRow === row) return
    this.currentStoryRow?.removeEventListener(
      "data_change",
      this.handleCurrentStoryChange
    )
    this.currentStoryRow = row
    row?.addEventListener("data_change", this.handleCurrentStoryChange)
  }

  private readonly handleCurrentStoryChange = (): void => {
    // StoryListItem updates its story reference from the same event.
    queueMicrotask(() => this.render(this.session.snapshot()))
  }

  private render(state: Readonly<ReadingSessionState>): void {
    const tab = this.tabs.selected ?? null
    if (this.readerModeTab && this.readerModeTab === tab && state.mode !== "reader") this.ttsControls.stop()
    this.readerModeTab = state.mode === "reader" ? tab : null
    const story = state.story
    // Keep the native navigation state observable from the Capacitor shell.
    // Besides driving styling/debugging, this gives native acceptance tests a
    // stable contract that only becomes "ready" after the secondary WebView
    // reports navigationFinished.
    this.content.dataset.mode = state.mode
    this.content.dataset.loadState = state.loadState
    this.content.dataset.navigationId = String(state.navigationId)
    const browserLoading = required("#reading_browser_loading")
    browserLoading.hidden = state.mode === "reader" || state.loadState !== "loading"
    browserLoading.textContent = this.nativeReading.isBrowserOpened() ? "Loading page…" : "Starting browser…"
    if (state.navigationId !== this.renderedNavigationId) {
      this.renderedNavigationId = state.navigationId
      this.clearValidation()
    }
    required("#reading_empty").hidden = state.currentUrl !== ""
    const isStoryPage = story != null && storyPageUrls(state.currentUrl, {
      ...state.pageContext,
      failed: state.loadState === "error"
    }).some(url => story.matches_url(url))
    const matchingStory = isStoryPage ? this.storyElement() : null
    this.observeCurrentStory(matchingStory)
    this.addonTrays.setStory(matchingStory)
    this.addonTrays.setPage(state.currentUrl || null)
    const displayedStory = matchingStory?.story ?? story
    const currentCard = required("#reading_current_card")
    const storyHref = displayedStory?.href ?? ""
    this.storyCollapse.showStory(storyHref)
    currentCard.hidden = !isStoryPage
    // The actions belong to the feed row; a story the feed dropped has none.
    required("#reading_story_menu").hidden = !matchingStory
    currentCard.classList.toggle("stared", Boolean(displayedStory?.stared))
    this.storyCollapse.render()
    const title = required<HTMLAnchorElement>("#reading_title")
    title.textContent = displayedStory?.title ?? "Reading"
    const comments = required<HTMLButtonElement>("#reading_comments")
    const sourceTag = required("#reading_type")
    sourceTag.textContent = displayedStory?.type ?? ""
    const showingComments = Boolean(
      displayedStory?.comment_url &&
      state.mode === "comments"
    )
    const toggleUrl = showingComments
      ? displayedStory?.href
      : displayedStory?.comment_url ?? displayedStory?.href
    const toggleLabel = showingComments || !displayedStory?.comment_url
      ? "Open story"
      : "Open comments"
    title.href = toggleUrl ?? ""
    title.setAttribute("aria-label", toggleLabel)
    sourceTag.setAttribute("aria-label", toggleLabel)
    comments.hidden = !isStoryPage || !displayedStory?.comment_url
    required("#reading_story_time").textContent =
      displayedStory ? humanTime(displayedStory.timestamp) : ""
    required("#reading_story_meta").dataset.type =
      displayedStory ? `[${displayedStory.type}]` : ""
    required("#reading_story_menu").dataset.type =
      displayedStory ? `[${displayedStory.type}]` : ""
    renderStoryTags(displayedStory?.tags ?? [])
    const address = required<HTMLInputElement>("#reading_url")
    if (!this.editingAddress) address.value = state.currentUrl
    required("#reading_reader_toggle").classList.toggle(
      "active",
      state.mode === "reader"
    )
    this.ttsControls.setReaderMode(
      this.activePanel === "reading" &&
      state.mode === "reader" &&
      state.loadState === "ready" &&
      Boolean(state.currentUrl)
    )
    this.renderAddressAction()
    const error = required("#reading_error")
    const browserFailed = state.mode !== "reader" && state.loadState === "error"
    error.hidden = !browserFailed
    required("#reading_browser_error_message").textContent = browserFailed
      ? state.error || "The page did not load. Check the address or try again."
      : ""
    const readerStatus = required("#reading_reader_status")
    const readerLoading = required("#reading_reader_loading")
    const readerFailure = required("#reading_reader_failure")
    const readerError = required("#reading_reader_error_message")
    const showsReaderStatus = state.mode === "reader" &&
      (state.loadState === "loading" || state.loadState === "error")
    readerStatus.hidden = !showsReaderStatus
    readerLoading.hidden = state.mode !== "reader" ||
      state.loadState !== "loading"
    readerFailure.hidden = state.mode !== "reader" ||
      state.loadState !== "error"
    readerError.textContent = state.mode === "reader" ? state.error ?? "" : ""
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
    this.ensureCurrentTab()
    if (normalized.url === state.currentUrl && state.mode !== "reader") {
      if (state.loadState !== "loading") {
        await this.nativeReading.reload()
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
      if (this.nativeReading.isBrowserOpened() && state.loadState !== "loading") {
        await this.nativeReading.reload()
      }
      return
    }

    this.session.setMode("comments")
  }

  private async toggleStoryAndComments(): Promise<void> {
    const state = this.session.snapshot()
    if (
      state.story?.comment_url &&
      state.mode !== "comments"
    ) {
      await this.openComments()
      return
    }
    await this.openStoryContent()
  }

  private async openStoryContent(): Promise<void> {
    const state = this.session.snapshot()
    const storyHref = state.story?.href
    if (!storyHref) return
    const storyUrl = URLRedirect.redirect_url(storyHref)
    if (state.mode === "browser" && state.currentUrl === storyUrl) {
      if (this.nativeReading.isBrowserOpened() && state.loadState !== "loading") {
        await this.nativeReading.reload()
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
    required("#reading_url_clear").hidden = !this.editingAddress || input.value === ""
    action.classList.toggle("reading-go", changed)
    action.classList.toggle(
      "loading",
      state.loadState === "loading" && !changed
    )
    action.setAttribute("aria-label", changed ? "Go to address" : "Reload")
    action.disabled = state.loadState === "loading" && !changed
  }

}


function required<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing mobile Reading element: ${selector}`)
  return element
}
