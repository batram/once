import {
  ElectronBridge,
  ElectronTabState
} from "@once/platform-electron/bridge"

const TAB_MIME = "application/x-once-tab"
const SPLIT_RATIO_KEY = "once-electron-split-ratio"

export class BrowserShell {
  private tabs: ElectronTabState[] = []
  private readonly leftPanel: HTMLElement
  private readonly rightPanel: HTMLElement
  private readonly dropzone: HTMLElement
  private readonly tabStrip: HTMLElement
  private readonly tabContent: HTMLElement
  private readonly address: HTMLInputElement
  private readonly backButton: HTMLButtonElement
  private readonly forwardButton: HTMLButtonElement
  private readonly reloadButton: HTMLButtonElement
  private readonly readerButton: HTMLButtonElement
  private readonly closeButton: HTMLButtonElement
  private readonly addressError: HTMLElement
  private readonly splitter: HTMLElement
  private readonly targetUrl: HTMLElement
  private draggingTabId: string | null = null
  private dropHandled = false
  private renderedAddressTabId: string | null = null
  private renderedAddressUrl = ""

  constructor(
    private readonly bridge: ElectronBridge,
    private readonly openReader: (url: string) => Promise<void>
  ) {
    const windowContent = required<HTMLElement>("#window_content")
    this.leftPanel = required<HTMLElement>("#left_panel")

    this.splitter = document.createElement("div")
    this.splitter.id = "sep_slider"
    windowContent.append(this.splitter)

    this.rightPanel = document.createElement("section")
    this.rightPanel.id = "right_panel"
    this.rightPanel.innerHTML = `
      <div id="tab_dropzone" class="bar">
        <div id="electron_tabs" role="tablist" aria-label="Browser tabs"></div>
        <button id="new_tab_btn" class="legacy-tab-button" title="New tab" aria-label="New tab">+</button>
      </div>
      <div id="controlbar" class="bar">
        <button id="browser_back" class="browser-button image-button" title="Back" aria-label="Back">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M19 12H5M11 6l-6 6 6 6" /></svg>
        </button>
        <button id="browser_forward" class="browser-button image-button" title="Forward" aria-label="Forward">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 12h14M13 6l6 6-6 6" /></svg>
        </button>
        <input id="urlfield" type="text" spellcheck="false" aria-label="Address" aria-describedby="url_error" placeholder="type URL here" />
        <button id="browser_reader" class="browser-button image-button" title="Reader mode" aria-label="Reader mode">
          <img src="imgs/article.svg" alt="" />
        </button>
        <button id="browser_reload" class="browser-button image-button" title="Reload" aria-label="Reload">
          <img src="imgs/reload.svg" alt="" />
        </button>
        <button id="browser_close" class="browser-button image-button" title="Close tab" aria-label="Close tab">
          <img src="imgs/x.svg" alt="" />
        </button>
      </div>
      <div id="url_error" role="alert" aria-live="polite"></div>
      <div id="tab_content"></div>
    `
    windowContent.append(this.rightPanel)

    this.targetUrl = document.createElement("div")
    this.targetUrl.id = "url_target"
    this.targetUrl.setAttribute("aria-hidden", "true")
    windowContent.append(this.targetUrl)

    this.dropzone = required<HTMLElement>("#tab_dropzone")
    this.tabStrip = required<HTMLElement>("#electron_tabs")
    this.tabContent = required<HTMLElement>("#tab_content")
    this.address = required<HTMLInputElement>("#urlfield")
    this.addressError = required<HTMLElement>("#url_error")
    this.backButton = required<HTMLButtonElement>("#browser_back")
    this.forwardButton = required<HTMLButtonElement>("#browser_forward")
    this.reloadButton = required<HTMLButtonElement>("#browser_reload")
    this.readerButton = required<HTMLButtonElement>("#browser_reader")
    this.closeButton = required<HTMLButtonElement>("#browser_close")

    this.bindControls()
    this.bindTabs()
    this.bindLayout()
    this.bindWindowState()
    this.bridge.tabs.onChanged((tabs) => this.render(tabs))
    void this.bridge.tabs.getAll().then((tabs) => this.render(tabs))
  }

  setLeftCollapsed(collapsed: boolean): void {
    document.body.classList.toggle("electron-left-collapsed", collapsed)
    this.reportBounds()
  }

  private bindControls(): void {
    required<HTMLButtonElement>("#new_tab_btn").onclick = () => {
      void this.bridge.tabs.create("about:blank", true)
    }
    this.backButton.onclick = () => this.withActive((tab) => this.bridge.tabs.back(tab.id))
    this.forwardButton.onclick = () =>
      this.withActive((tab) => this.bridge.tabs.forward(tab.id))
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
        this.setAddressError(readerErrorMessage(error))
      })
    }
    this.closeButton.onclick = () =>
      this.withActive((tab) => this.bridge.tabs.close(tab.id))

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
        this.setAddressError(
          error instanceof Error ? error.message : String(error)
        )
      }
    })
  }

  private bindTabs(): void {
    this.tabStrip.addEventListener("wheel", (event) => {
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return
      this.tabStrip.scrollLeft += event.deltaY
      event.preventDefault()
    }, { passive: false })

    for (const element of [this.dropzone, this.tabStrip, this.rightPanel]) {
      element.addEventListener("dragover", (event) => {
        if (!this.hasSupportedDrop(event.dataTransfer)) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = this.hasTabDrop(event.dataTransfer)
          ? "move"
          : "link"
      })
    }
    this.dropzone.addEventListener("drop", (event) => {
      event.preventDefault()
      void this.handleDrop(event)
    })
  }

  private bindLayout(): void {
    const stored = Number.parseFloat(localStorage.getItem(SPLIT_RATIO_KEY) || "0.42")
    const initialRatio = Number.isFinite(stored) ? clamp(stored, 0.2, 0.8) : 0.42
    this.leftPanel.style.flex = `0 0 ${Math.round(initialRatio * 100)}%`
    this.rightPanel.style.flex = "1 1 auto"

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
      this.leftPanel.style.flexBasis = `${width}px`
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
    window.addEventListener("resize", () => this.reportBounds())
    requestAnimationFrame(() => this.reportBounds())
  }

  private bindWindowState(): void {
    this.bridge.window.onTargetUrlChanged((url) => {
      this.targetUrl.textContent = url.length > 160 ? `${url.slice(0, 157)}...` : url
      this.targetUrl.classList.toggle("visible", Boolean(url))
    })
    this.bridge.window.onFullscreenChanged((fullscreen) => {
      document.body.classList.toggle("electron-fullscreen", fullscreen)
      this.reportBounds()
    })
    window.addEventListener("keydown", (event) => {
      if (event.repeat) return
      if (event.key === "F11") {
        event.preventDefault()
        void this.bridge.window.setFullscreen(
          !document.body.classList.contains("electron-fullscreen")
        )
      } else if (
        event.key === "Escape" &&
        document.body.classList.contains("electron-fullscreen")
      ) {
        event.preventDefault()
        void this.bridge.window.setFullscreen(false)
      }
    })
  }

  private render(tabs: ElectronTabState[]): void {
    this.tabs = tabs
    this.tabStrip.innerHTML = ""

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

      if (tab.audible || tab.muted) {
        const media = document.createElement("button")
        media.className = "electron-tab-media"
        media.type = "button"
        media.title = tab.muted ? "Unmute tab" : "Mute tab"
        media.setAttribute("aria-label", media.title)
        const icon = document.createElement("img")
        icon.src = tab.muted ? "imgs/pause.svg" : "imgs/play.svg"
        icon.alt = ""
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
    }

    const active = this.activeTab()
    if (active) {
      const addressUrl = displayBrowserUrl(active.url)
      const navigationChanged =
        this.renderedAddressTabId !== active.id ||
        this.renderedAddressUrl !== addressUrl
      this.renderedAddressTabId = active.id
      this.renderedAddressUrl = addressUrl
      if (navigationChanged || document.activeElement !== this.address) {
        this.address.value = addressUrl
      }
      this.backButton.disabled = !active.canGoBack
      this.forwardButton.disabled = !active.canGoForward
      this.reloadButton.innerHTML = active.loading
        ? '<span class="stop-symbol" aria-hidden="true">×</span>'
        : '<img src="imgs/reload.svg" alt="" />'
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
        void this.bridge.tabs.detach(id, { x: event.screenX, y: event.screenY }).catch((): void => undefined)
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
    return types.includes(TAB_MIME) || types.includes("text/uri-list") || types.includes("text/plain")
  }

  private activeTab(): ElectronTabState | undefined {
    return this.tabs.find((tab) => tab.active)
  }

  private setAddressError(message: string): void {
    this.addressError.textContent = message
    this.addressError.classList.toggle("visible", Boolean(message))
    this.address.toggleAttribute("aria-invalid", Boolean(message))
    this.reportBounds()
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
