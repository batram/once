import { InAppBrowserSurface, normalizeReadingUrl } from "@once/platform-mobile"
import { humanTime, URLRedirect } from "@once/core"
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
import { ReadingSurfaceCoordinator } from "./readingSurfaceCoordinator"

export class MobileReadingController {
  readonly session
  private readonly addonTrays: ReadingAddonTrays
  private readonly content: HTMLElement
  private readonly nativeReading: ReadingSurfaceCoordinator
  private activePanel = "stories"
  private settingsReturnPanel: "stories" | "reading" = "stories"
  private editingAddress = false
  private currentStoryRow: StoryListItem | null = null
  private currentCardStoryHref = ""
  private currentStoryCollapsed = false

  openBrowserUrl(url: string): void {
    PanelNavigation.open_panel("reading")
    this.session.navigate(url)
  }

  constructor(
    surface: InAppBrowserSurface,
    reader: ReaderDocumentHost,
    private readonly ttsControls: ReaderTtsUiControls
  ) {
    this.content = required("#reading_content")
    this.nativeReading = new ReadingSurfaceCoordinator(
      new ReadingSession(),
      surface,
      reader,
      this.content
    )
    this.addonTrays = new ReadingAddonTrays(this.content, open => this.nativeReading.setOverlayOpen(open))
    this.session = this.nativeReading.session
    this.bindControls()
    this.bindEvents()
    this.session.subscribe((state) => {
      this.render(state)
    })
  }

  async install(): Promise<void> {
    await this.nativeReading.install()
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

    if (this.activePanel === "reading" && this.addonTrays.close()) return true

    if (this.activePanel === "settings") {
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

  close(): void {
    this.clearReading()
    PanelNavigation.open_panel("stories")
  }

  private clearReading(): void {
    this.ttsControls.dismiss()
    this.nativeReading.closeReading()
  }

  private bindEvents(): void {
    // Native browser views sit above the webview, including its modal dialogs.
    let dialogOpen = false
    new MutationObserver(() => {
      const open = Boolean(document.querySelector("dialog[open]"))
      if (open === dialogOpen) return
      dialogOpen = open
      this.nativeReading.setDialogOpen(open)
    }).observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] })
    document.body.addEventListener(READING_REQUEST, (rawEvent) => {
      const event = rawEvent as ReadingRequestEvent
      event.preventDefault()
      this.session.setVisibleStories(StoryList.visibleStories())
      // Panel selection is synchronous: expose and lay out #reading_content
      // before session.open publishes the state that measures its bounds.
      this.activePanel = "reading"
      PanelNavigation.open_panel("reading")
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
    required<HTMLButtonElement>("#reading_story_collapse").onclick = () => {
      this.setCurrentStoryCollapsed(!this.currentStoryCollapsed)
    }
    this.bindCurrentStorySwipe(currentCard)
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
    required<HTMLButtonElement>("#reading_story_menu").onclick = (event) => {
      const story = this.storyElement()
      if (!story) return
      const anchor = event.currentTarget as HTMLElement
      if (!this.nativeReading.isAvailable()) {
        this.nativeReading.setMenuOpen(true)
      }
      story.requestMenu(anchor)
    }
    document.addEventListener("once-story-menu-closed", () => {
      // The anchored menu closes before it executes its action. Refresh on the
      // next microtask so synchronous changes such as bookmarking are visible.
      queueMicrotask(() => this.render(this.session.snapshot()))
      this.nativeReading.setMenuOpen(false)
    })
  }

  private storyElement(): StoryListItem | null {
    const href = this.session.snapshot().story?.href
    if (!href) return null
    return Array.from(document.querySelectorAll<StoryListItem>("story-item"))
      .find((row) => row.story.href === href) ?? null
  }

  private bindCurrentStorySwipe(card: HTMLElement): void {
    let pointerId: number | null = null
    let startX = 0
    let startY = 0
    let vertical = false
    let suppressClick = false

    const finish = (event: PointerEvent): void => {
      if (event.pointerId !== pointerId) return
      const distance = event.clientY - startY
      pointerId = null
      card.classList.remove("reading_story_dragging")
      card.style.removeProperty("--reading-story-drag")
      if (!vertical) return
      suppressClick = Math.abs(distance) > 12
      if (distance <= -32) this.setCurrentStoryCollapsed(true)
      if (distance >= 32) this.setCurrentStoryCollapsed(false)
    }

    card.addEventListener("pointerdown", (event) => {
      if (!event.isPrimary || event.button !== 0) return
      if ((event.target as Element | null)?.closest(
        'a, button, [role="link"], input, select, textarea'
      )) return
      pointerId = event.pointerId
      startX = event.clientX
      startY = event.clientY
      vertical = false
      card.setPointerCapture(event.pointerId)
    })
    card.addEventListener("pointermove", (event) => {
      if (event.pointerId !== pointerId) return
      const distanceX = event.clientX - startX
      const distanceY = event.clientY - startY
      if (!vertical && Math.max(Math.abs(distanceX), Math.abs(distanceY)) < 8) {
        return
      }
      if (!vertical && Math.abs(distanceX) >= Math.abs(distanceY)) {
        pointerId = null
        return
      }
      vertical = true
      event.preventDefault()
      const drag = Math.max(-40, Math.min(40, distanceY))
      card.classList.add("reading_story_dragging")
      card.style.setProperty("--reading-story-drag", `${drag}px`)
    })
    card.addEventListener("pointerup", finish)
    card.addEventListener("pointercancel", finish)
    card.addEventListener("click", (event) => {
      if (!suppressClick) return
      suppressClick = false
      event.preventDefault()
      event.stopPropagation()
    }, true)
  }

  private setCurrentStoryCollapsed(collapsed: boolean): void {
    if (this.currentStoryCollapsed === collapsed) return
    this.currentStoryCollapsed = collapsed
    this.renderCurrentStoryCollapse()
    void this.nativeReading.updateBounds()
  }

  private renderCurrentStoryCollapse(): void {
    const card = required("#reading_current_card")
    const button = required<HTMLButtonElement>("#reading_story_collapse")
    card.classList.toggle(
      "reading_story_collapsed",
      this.currentStoryCollapsed
    )
    button.textContent = this.currentStoryCollapsed ? "⌄" : "⌃"
    button.setAttribute("aria-expanded", String(!this.currentStoryCollapsed))
    button.setAttribute(
      "aria-label",
      this.currentStoryCollapsed
        ? "Expand current story"
        : "Collapse current story"
    )
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
    const story = state.story
    // Keep the native navigation state observable from the Capacitor shell.
    // Besides driving styling/debugging, this gives native acceptance tests a
    // stable contract that only becomes "ready" after the secondary WebView
    // reports navigationFinished.
    this.content.dataset.mode = state.mode
    this.content.dataset.loadState = state.loadState
    this.content.dataset.navigationId = String(state.navigationId)
    required("#reading_empty").hidden = state.currentUrl !== ""
    const redirectedStoryUrl = story
      ? URLRedirect.redirect_url(story.href)
      : ""
    const isStoryPage = story != null &&
      (
        state.currentUrl === redirectedStoryUrl ||
        state.currentUrl === story.comment_url
      )
    const matchingStory = isStoryPage ? this.storyElement() : null
    this.observeCurrentStory(matchingStory)
    this.addonTrays.setStory(matchingStory)
    const displayedStory = matchingStory?.story ?? story
    const currentCard = required("#reading_current_card")
    const storyHref = displayedStory?.href ?? ""
    if (storyHref !== this.currentCardStoryHref) {
      this.currentCardStoryHref = storyHref
      this.currentStoryCollapsed = false
    }
    currentCard.hidden = matchingStory == null
    currentCard.classList.toggle("stared", Boolean(displayedStory?.stared))
    this.renderCurrentStoryCollapse()
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
    comments.hidden = matchingStory == null || !displayedStory?.comment_url
    required("#reading_story_time").textContent =
      displayedStory ? humanTime(displayedStory.timestamp) : ""
    required("#reading_story_meta").dataset.type =
      displayedStory ? `[${displayedStory.type}]` : ""
    required("#reading_story_menu").dataset.type =
      displayedStory ? `[${displayedStory.type}]` : ""
    this.renderStoryTags(displayedStory?.tags ?? [])
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
    const browserError = state.mode !== "reader" ? state.error : null
    error.hidden = browserError == null
    error.textContent = browserError ?? ""
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
        element.classList.add("tag--icon")
        element.style.setProperty("--tag-icon", `url(${tag.icon})`)
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
