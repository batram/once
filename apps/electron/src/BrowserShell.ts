import { ElectronBridge, ElectronTabState } from "@once/platform-electron/bridge"
import {
  focusStoryList,
  getKeyboardDispatcher,
  refreshPaneFocus,
  revealElement,
  setPaneFocus
} from "@once/ui-web"
import browserShellMarkup from "./browser/browser-shell.html"

const TAB_MIME = "application/x-once-tab"
const SPLIT_RATIO_KEY = "once-electron-split-ratio"
const STORY_POSITION_KEY = "once-electron-story-position"
type StoryPosition = "sidebar" | "browser"

export class BrowserShell {
  private tabs: ElectronTabState[] = []
  private readonly leftPanel: HTMLElement
  private readonly rightPanel: HTMLElement
  private readonly dropzone: HTMLElement
  private readonly tabStrip: HTMLElement
  private readonly newTabButton: HTMLButtonElement
  private readonly tabContent: HTMLElement
  private readonly address: HTMLInputElement
  private readonly backButton: HTMLButtonElement
  private readonly forwardButton: HTMLButtonElement
  private readonly reloadButton: HTMLButtonElement
  private readonly readerButton: HTMLButtonElement
  private readonly closeButton: HTMLButtonElement
  private readonly addressError: HTMLElement
  private readonly splitter: HTMLElement
  private draggingTabId: string | null = null
  private dropHandled = false
  private activeTabElement: HTMLElement | null = null
  private renderedAddressTabId: string | null = null
  private renderedAddressUrl = ""

  constructor(
    private readonly bridge: ElectronBridge,
    private readonly openReader: (url: string) => Promise<void>
  ) {
    const windowContent = required<HTMLElement>("#window_content")
    this.leftPanel = required<HTMLElement>("#left_panel")

    const template = document.createElement("template")
    template.innerHTML = browserShellMarkup.trim()
    windowContent.append(template.content.cloneNode(true))

    this.splitter = required<HTMLElement>("#sep_slider")
    this.rightPanel = required<HTMLElement>("#right_panel")

    this.dropzone = required<HTMLElement>("#tab_dropzone")
    this.tabStrip = required<HTMLElement>("#electron_tabs")
    this.newTabButton = required<HTMLButtonElement>("#new_tab_btn")
    this.tabContent = required<HTMLElement>("#tab_content")
    this.address = required<HTMLInputElement>("#urlfield")
    this.addressError = required<HTMLElement>("#url_error")
    this.backButton = required<HTMLButtonElement>("#browser_back")
    this.forwardButton = required<HTMLButtonElement>("#browser_forward")
    this.reloadButton = required<HTMLButtonElement>("#browser_reload")
    this.readerButton = required<HTMLButtonElement>("#browser_reader")
    this.closeButton = required<HTMLButtonElement>("#browser_close")

    this.bindStoryPosition()

    this.bindControls()
    this.bindTabs()
    this.bindLayout()
    this.bindWindowState()
    this.bindKeyboardCommands()
    this.bridge.tabs.onChanged((tabs) => this.render(tabs))
    this.bridge.tabs.onRegenerateReader((sourceUrl) => {
      this.setAddressError("")
      void this.openReader(sourceUrl).catch((error) => {
        this.showReaderError(sourceUrl, error)
      })
    })
    void this.bridge.tabs.getAll().then((tabs) => this.render(tabs))
  }

  setLeftCollapsed(collapsed: boolean): void {
    document.body.classList.toggle("electron-left-collapsed", collapsed)
    this.reportBounds()
  }

  private bindStoryPosition(): void {
    const settings = required<HTMLElement>("#electron_layout_settings")
    const select = required<HTMLSelectElement>("#electron_story_position")
    settings.hidden = false
    const stored = localStorage.getItem(STORY_POSITION_KEY)
    const position: StoryPosition = stored === "browser" ? "browser" : "sidebar"
    select.value = position
    this.setStoryPosition(position)
    select.addEventListener("change", () => {
      const next: StoryPosition = select.value === "browser" ? "browser" : "sidebar"
      localStorage.setItem(STORY_POSITION_KEY, next)
      this.setStoryPosition(next)
    })
  }

  private setStoryPosition(position: StoryPosition): void {
    const selected = required<HTMLElement>("#selected_container")
    if (position === "browser") {
      this.rightPanel.insertBefore(selected, this.tabContent)
    } else {
      required<HTMLElement>("#stories_panel").insertBefore(
        selected,
        required<HTMLElement>("#stories")
      )
    }
    document.body.dataset.electronStoryPosition = position
  }

  private bindControls(): void {
    this.newTabButton.onclick = () => {
      void this.bridge.tabs.create("about:blank", true)
    }
    this.backButton.onclick = () => this.withActive((tab) => this.bridge.tabs.back(tab.id))
    this.forwardButton.onclick = () => this.withActive((tab) => this.bridge.tabs.forward(tab.id))
    this.reloadButton.onclick = () => {
      this.withActive((tab) =>
        tab.loading ? this.bridge.tabs.stop(tab.id) : this.bridge.tabs.reload(tab.id)
      )
    }
    this.readerButton.onclick = () => {
      const active = this.activeTab()
      if (!active) return
      this.setAddressError("")
      const readerSource = sourceUrlFromReaderUrl(active.url)
      if (readerSource) {
        void this.bridge.tabs.navigate(active.id, readerSource).catch((error) => {
          this.setAddressError(readerErrorMessage(error))
        })
        return
      }
      if (!isReadableUrl(active.url)) return
      void this.openReader(active.url).catch((error) => {
        this.showReaderError(active.url, error)
      })
    }
    this.closeButton.onclick = () => this.withActive((tab) => this.bridge.tabs.close(tab.id))

    this.address.addEventListener("focus", () => this.address.select())
    this.address.addEventListener("input", () => this.setAddressError(""))
    this.address.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") return
      const active = this.activeTab()
      if (!active) return
      const url = this.address.value
      this.address.blur()
      try {
        this.setAddressError("")
        await this.bridge.tabs.navigate(active.id, url)
      } catch (error) {
        this.setAddressError(error instanceof Error ? error.message : String(error))
      }
    })
  }

  private bindTabs(): void {
    const clearWindowDropState = () => {
      document.body.classList.remove("window-is-receiving-drop")
    }
    this.tabStrip.addEventListener(
      "wheel",
      (event) => {
        if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
        this.tabStrip.scrollLeft += event.deltaY
        event.preventDefault()
      },
      { passive: false }
    )

    window.addEventListener("dragenter", (e) => {
      e.preventDefault()
      document.body.classList.add("window-is-receiving-drop")
    })

    window.addEventListener("dragleave", (e) => {
      // Only reset if exiting the root screen bounds
      if (e.screenX === 0 && e.screenY === 0) {
        document.body.classList.remove("window-is-receiving-drop")
      }
    })

    // Capture cleanup before an internal drop handler can stop propagation.
    // Otherwise a settings reorder can leave the entire window in no-drag mode.
    window.addEventListener("drop", clearWindowDropState, { capture: true })
    window.addEventListener("dragend", clearWindowDropState, { capture: true })

    document.addEventListener("dragover", (event) => {
      // A control inside the shell may already own this drag. In particular,
      // structured settings rows use text/plain for internal reordering and
      // set dropEffect to "move"; treating that payload as a dropped URL here
      // changes it to "link" and prevents native Electron drops from completing.
      if (event.defaultPrevented) return
      if (!this.hasSupportedDrop(event.dataTransfer)) return
      event.preventDefault()
      if (event.dataTransfer)
        event.dataTransfer.dropEffect = this.hasTabDrop(event.dataTransfer) ? "move" : "link"
    })
    document.addEventListener("drop", (event) => {
      clearWindowDropState()
      event.preventDefault()
      void this.handleDrop(event)
    })
  }

  private bindLayout(): void {
    const stored = Number.parseFloat(localStorage.getItem(SPLIT_RATIO_KEY) || "0.42")
    const initialRatio = Number.isFinite(stored) ? clamp(stored, 0.2, 0.8) : 0.42
    this.leftPanel.style.setProperty(
      "--electron-left-panel-basis",
      `${initialRatio * 100}%`
    )

    let dragging = false
    this.splitter.addEventListener("pointerdown", (event) => {
      dragging = true
      document.body.classList.add("electron-resizing")
      this.splitter.setPointerCapture(event.pointerId)
      event.preventDefault()
    })
    this.splitter.addEventListener("pointermove", (event) => {
      if (!dragging) return
      const minimum = 280
      const maximum = Math.max(minimum, window.innerWidth - 320)
      const width = Math.min(maximum, Math.max(minimum, event.clientX))
      this.leftPanel.style.setProperty(
        "--electron-left-panel-basis",
        `${width / window.innerWidth * 100}%`
      )
      this.reportBounds()
    })
    this.splitter.addEventListener("pointerup", (event) => {
      dragging = false
      document.body.classList.remove("electron-resizing")
      this.splitter.releasePointerCapture(event.pointerId)
      const ratio = this.leftPanel.getBoundingClientRect().width / window.innerWidth
      localStorage.setItem(SPLIT_RATIO_KEY, String(clamp(ratio, 0.2, 0.8)))
      this.reportBounds()
    })

    const observer = new ResizeObserver(() => this.reportBounds())
    observer.observe(this.tabContent)
    const tabStripObserver = new ResizeObserver(() => {
      this.layoutTabs()
      this.scrollActiveTabIntoView()
    })
    tabStripObserver.observe(this.dropzone)
    window.addEventListener("resize", () => this.reportBounds())
    requestAnimationFrame(() => this.reportBounds())
  }

  private bindWindowState(): void {
    this.bridge.window.onFullscreenChanged((fullscreen) => {
      document.body.classList.toggle("electron-fullscreen", fullscreen)
      this.reportBounds()
    })
    // Native focus is the authority on which pane the keys reach. Opening a
    // story hands focus to the page without any DOM event the shell can see,
    // so main reports it instead of the shell guessing.
    this.bridge.window.onNativeFocusChanged((surface) => {
      if (surface === "browser") setPaneFocus("browser")
      else refreshPaneFocus()
    })
  }

  /**
   * Browser commands. Keys pressed while a page has focus never reach this
   * renderer, so the bound chords are handed to the main process, which steals
   * them from the page and sends them back as key commands.
   */
  private bindKeyboardCommands(): void {
    const keyboard = getKeyboardDispatcher()
    keyboard.register("browser.new-tab", () => {
      void this.bridge.tabs.create("about:blank", true)
    })
    keyboard.register("browser.close-tab", () =>
      this.withActive((tab) => this.bridge.tabs.close(tab.id)))
    keyboard.register("browser.restore-closed-tab", () => {
      void this.bridge.tabs.restoreClosed()
    })
    keyboard.register("browser.new-window", () => {
      void this.bridge.window.create()
    })
    keyboard.register("browser.next-tab", () => this.cycleTab(1))
    keyboard.register("browser.prev-tab", () => this.cycleTab(-1))
    // A renderer-side focus() is silently ignored while a WebContentsView owns
    // native focus, so anything aiming at the shell has to take it back first.
    keyboard.register("browser.focus-urlbar", () => {
      void this.bridge.window.focusShell().then(() => this.address.focus())
    })
    keyboard.register("panes.focus-right", () => this.focusContent())
    keyboard.register("panes.focus-left", () => {
      setPaneFocus("stories")
      void this.bridge.window.focusShell().then(() => focusStoryList())
    })
    keyboard.register("window.toggle-fullscreen", () => {
      void this.bridge.window.setFullscreen(
        !document.body.classList.contains("electron-fullscreen")
      )
    })
    keyboard.register("window.exit-fullscreen", () => {
      if (!document.body.classList.contains("electron-fullscreen")) return
      void this.bridge.window.setFullscreen(false)
    })

    // The chord was pressed inside a page, so native focus sits in the
    // WebContentsView. A renderer-side focus() is silently ignored there, which
    // is why every forwarded command takes the shell back first; commands that
    // want the page focused (next tab, focus content) hand it straight on.
    this.bridge.window.onKeyCommand((chord) => {
      void this.bridge.window.focusShell().then(() => keyboard.dispatchChord(chord))
    })
    this.publishForwardedKeys()
  }

  /** Keeps the main process in step with whatever the user has bound. */
  publishForwardedKeys(): void {
    void this.bridge.window.setForwardedKeys(getKeyboardDispatcher().boundChords())
  }

  private focusContent(): void {
    setPaneFocus("browser")
    void this.bridge.tabs.focusContent()
  }

  private cycleTab(delta: number): void {
    if (this.tabs.length < 2) return
    const index = this.tabs.findIndex((tab) => tab.active)
    if (index < 0) return
    const next = (index + delta + this.tabs.length) % this.tabs.length
    setPaneFocus("browser")
    void this.bridge.tabs.activate(this.tabs[next].id)
  }

  private render(tabs: ElectronTabState[]): void {
    this.tabs = tabs
    this.tabStrip.replaceChildren()
    this.activeTabElement = null

    for (const tab of tabs) {
      const element = document.createElement("div")
      element.className = "electron-tab"
      element.classList.toggle("active", tab.active)
      element.setAttribute("role", "tab")
      element.setAttribute("aria-selected", String(tab.active))
      element.tabIndex = tab.active ? 0 : -1
      element.title = tab.title
      element.draggable = true
      element.dataset.tabId = tab.id

      if (tab.hasPlayedAudio || tab.muted) {
        const media = document.createElement("button")
        media.className = "electron-tab-media"
        media.type = "button"
        media.title = tab.muted ? "Unmute tab" : "Mute tab"
        media.setAttribute("aria-label", media.title)
        const icon = document.createElement("span")
        icon.className = `icon icon--chrome icon--${
          tab.muted ? "volume-mute" : "volume"
        }`
        icon.setAttribute("aria-hidden", "true")
        media.append(icon)
        media.onclick = (event) => {
          event.stopPropagation()
          void this.bridge.tabs.toggleMuted(tab.id)
        }
        element.append(media)
      }

      const title = document.createElement("span")
      title.className = "electron-tab-title"
      title.textContent = tab.title || "New tab"
      element.append(title)

      const close = document.createElement("button")
      close.className = "electron-tab-close"
      close.type = "button"
      close.textContent = "×"
      close.title = "Close tab"
      close.setAttribute("aria-label", `Close ${tab.title || "tab"}`)
      close.onclick = (event) => {
        event.stopPropagation()
        void this.bridge.tabs.close(tab.id)
      }
      element.append(close)

      element.onclick = () => void this.bridge.tabs.activate(tab.id)
      element.onmousedown = (event) => {
        if (event.button === 1) {
          event.preventDefault()
        }
      }
      element.onauxclick = (event) => {
        if (event.button !== 1) return
        event.preventDefault()
        void this.bridge.tabs.close(tab.id)
      }
      element.onkeydown = (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault()
          void this.bridge.tabs.activate(tab.id)
        }
      }
      element.oncontextmenu = (event) => {
        event.preventDefault()
        void this.bridge.tabs.showMenu(tab.id, { x: event.x, y: event.y })
      }
      this.bindTabDrag(element, tab)
      this.tabStrip.append(element)
      if (tab.active) this.activeTabElement = element
    }

    this.layoutTabs()
    this.scrollActiveTabIntoView()

    const active = this.activeTab()
    if (active) {
      const addressUrl = displayBrowserUrl(active.url)
      const navigationChanged =
        this.renderedAddressTabId !== active.id || this.renderedAddressUrl !== addressUrl
      this.renderedAddressTabId = active.id
      this.renderedAddressUrl = addressUrl
      if (navigationChanged || document.activeElement !== this.address) {
        this.address.value = addressUrl
      }
      this.backButton.disabled = !active.canGoBack
      this.forwardButton.disabled = !active.canGoForward
      const reloadContent = document.createElement("span")
      if (active.loading) {
        reloadContent.className = "stop-symbol"
        reloadContent.setAttribute("aria-hidden", "true")
        reloadContent.textContent = "×"
      } else {
        reloadContent.className = "icon icon--chrome icon--reload"
        reloadContent.setAttribute("aria-hidden", "true")
      }
      this.reloadButton.replaceChildren(reloadContent)
      this.reloadButton.title = active.loading ? "Stop" : "Reload"
      this.reloadButton.setAttribute("aria-label", this.reloadButton.title)
      this.reloadButton.disabled = false
      const readerActive = sourceUrlFromReaderUrl(active.url) != null
      this.readerButton.disabled = !readerActive && !isReadableUrl(active.url)
      this.readerButton.classList.toggle("active", readerActive)
      this.readerButton.title = readerActive ? "Exit reader mode" : "Reader mode"
      this.readerButton.setAttribute("aria-label", this.readerButton.title)
      this.closeButton.disabled = false
    } else {
      this.renderedAddressTabId = null
      this.renderedAddressUrl = ""
      this.backButton.disabled = true
      this.forwardButton.disabled = true
      this.reloadButton.disabled = true
      this.readerButton.disabled = true
      this.readerButton.classList.remove("active")
      this.closeButton.disabled = true
    }
    this.reportBounds()
  }

  private bindTabDrag(element: HTMLElement, tab: ElectronTabState): void {
    element.ondragstart = (event) => {
      if (!event.dataTransfer) return
      this.draggingTabId = tab.id
      this.dropHandled = false
      element.classList.add("dragging")
      event.dataTransfer.effectAllowed = "copyMove"
      event.dataTransfer.setData(TAB_MIME, tab.id)
      if (tab.url.startsWith("http://") || tab.url.startsWith("https://")) {
        event.dataTransfer.setData("text/uri-list", tab.url)
        event.dataTransfer.setData("text/plain", tab.url)
      }
    }
    element.ondragover = (event) => {
      if (!this.hasSupportedDrop(event.dataTransfer)) return
      event.preventDefault()
      this.clearDropMarkers()
      element.classList.add(
        event.clientX < element.getBoundingClientRect().left + element.clientWidth / 2
          ? "drop-before"
          : "drop-after"
      )
    }
    element.ondrop = (event) => {
      event.preventDefault()
      event.stopPropagation()
      void this.handleDrop(event, this.beforeIdForDrop(element, event.clientX))
    }
    element.ondragend = (event) => {
      element.classList.remove("dragging")
      this.clearDropMarkers()
      const id = this.draggingTabId
      this.draggingTabId = null
      if (id && !this.dropHandled && event.dataTransfer?.dropEffect === "none") {
        void this.bridge.tabs
          .detach(id, { x: event.screenX, y: event.screenY })
          .catch((): void => undefined)
      }
      this.dropHandled = false
    }
  }

  private async handleDrop(event: DragEvent, beforeId?: string): Promise<void> {
    const transfer = event.dataTransfer
    if (!transfer) return
    const tabId = transfer.getData(TAB_MIME)
    if (tabId) {
      this.dropHandled = true
      if (tabId === this.draggingTabId) {
        await this.bridge.tabs.reorder(tabId, beforeId)
      } else {
        await this.bridge.tabs.moveHere(tabId, beforeId)
      }
      this.clearDropMarkers()
      return
    }

    const urls = parseDroppedUrls(transfer)
    if (urls.length > 0) await this.bridge.tabs.openDroppedUrls(urls)
    this.clearDropMarkers()
  }

  private beforeIdForDrop(element: HTMLElement, clientX: number): string | undefined {
    if (clientX < element.getBoundingClientRect().left + element.clientWidth / 2) {
      return element.dataset.tabId
    }
    return element.nextElementSibling instanceof HTMLElement
      ? element.nextElementSibling.dataset.tabId
      : undefined
  }

  private clearDropMarkers(): void {
    this.tabStrip
      .querySelectorAll(".drop-before, .drop-after")
      .forEach((element) => element.classList.remove("drop-before", "drop-after"))
  }

  private hasTabDrop(transfer: DataTransfer): boolean {
    return Array.from(transfer.types).includes(TAB_MIME)
  }

  private hasSupportedDrop(transfer: DataTransfer | null): boolean {
    if (!transfer) return false
    const types = Array.from(transfer.types)
    return (
      types.includes(TAB_MIME) || types.includes("text/uri-list") || types.includes("text/plain")
    )
  }

  private activeTab(): ElectronTabState | undefined {
    return this.tabs.find((tab) => tab.active)
  }

  private scrollActiveTabIntoView(): void {
    if (this.activeTabElement) revealElement(this.activeTabElement)
  }

  private layoutTabs(): void {
    if (this.tabs.length === 0) return

    const dropzoneStyle = getComputedStyle(this.dropzone)
    const buttonStyle = getComputedStyle(this.newTabButton)
    const horizontalChrome =
      Number.parseFloat(dropzoneStyle.paddingLeft) +
      Number.parseFloat(dropzoneStyle.paddingRight) +
      this.newTabButton.offsetWidth +
      Number.parseFloat(buttonStyle.marginLeft) +
      Number.parseFloat(buttonStyle.marginRight)
    const tabMargin = 2
    const availableWidth = this.dropzone.clientWidth - horizontalChrome
    const tabWidth = Math.max(
      140,
      Math.min(220, Math.floor(availableWidth / this.tabs.length - tabMargin))
    )
    this.tabStrip.style.setProperty("--electron-tab-width", `${tabWidth}px`)
  }

  private setAddressError(message: string): void {
    this.addressError.textContent = message
    this.addressError.classList.toggle("visible", Boolean(message))
    this.address.toggleAttribute("aria-invalid", Boolean(message))
    this.reportBounds()
  }

  private showReaderError(sourceUrl: string, error: unknown): void {
    this.setAddressError("")
    void this.bridge.tabs
      .showReaderError(sourceUrl, readerErrorMessage(error))
      .catch((reportError) => {
        console.error("Failed to display the reader error page", reportError)
      })
  }

  private withActive(action: (tab: ElectronTabState) => Promise<unknown>): void {
    const active = this.activeTab()
    if (active) void action(active)
  }

  private reportBounds(): void {
    requestAnimationFrame(() => {
      const rect = this.tabContent.getBoundingClientRect()
      void this.bridge.tabs.setBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      })
    })
  }
}

function isReadableUrl(url: string): boolean {
  return url.startsWith("http://") || url.startsWith("https://")
}

function readerErrorMessage(error: unknown): string {
  const detail = error instanceof Error ? error.message : String(error)
  return `Reader mode failed: ${detail}`
}

function displayBrowserUrl(url: string): string {
  const source = sourceUrlFromReaderUrl(url)
  return source ? `once-reader://${source}` : url
}

function sourceUrlFromReaderUrl(url: string): string | null {
  if (!url.startsWith("once-reader://")) return null
  try {
    const parsed = new URL(url)
    if (parsed.hostname !== "http" && parsed.hostname !== "https") return null
    return new URL(`${parsed.hostname}:${parsed.pathname}${parsed.search}${parsed.hash}`).toString()
  } catch {
    return null
  }
}

function parseDroppedUrls(transfer: DataTransfer): string[] {
  const values = transfer.getData("text/uri-list") || transfer.getData("text/plain")
  const urls: string[] = []
  for (const line of values.split(/\r?\n/)) {
    const value = line.trim()
    if (!value || value.startsWith("#")) continue
    if (value.startsWith("http://") || value.startsWith("https://")) urls.push(value)
  }
  return [...new Set(urls)]
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value))
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Required element not found: ${selector}`)
  return element
}
