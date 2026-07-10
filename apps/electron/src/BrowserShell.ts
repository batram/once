import {
  ElectronBridge,
  ElectronTabState
} from "@once/platform-electron/bridge"

export class BrowserShell {
  private tabs: ElectronTabState[] = []
  private readonly leftPanel: HTMLElement
  private readonly rightPanel: HTMLElement
  private readonly tabStrip: HTMLElement
  private readonly tabContent: HTMLElement
  private readonly address: HTMLInputElement
  private readonly backButton: HTMLButtonElement
  private readonly forwardButton: HTMLButtonElement
  private readonly reloadButton: HTMLButtonElement
  private readonly splitter: HTMLElement

  constructor(private readonly bridge: ElectronBridge) {
    const windowContent = required<HTMLElement>("#window_content")
    this.leftPanel = required<HTMLElement>("#left_panel")

    this.splitter = document.createElement("div")
    this.splitter.id = "sep_slider"
    windowContent.append(this.splitter)

    this.rightPanel = document.createElement("section")
    this.rightPanel.id = "right_panel"
    this.rightPanel.innerHTML = `
      <div id="tab_dropzone" class="bar">
        <div id="electron_tabs" role="tablist"></div>
        <button id="new_tab_btn" class="browser-button" title="New tab">+</button>
      </div>
      <div id="controlbar" class="bar">
        <button id="browser_back" class="browser-button" title="Back">←</button>
        <button id="browser_forward" class="browser-button" title="Forward">→</button>
        <button id="browser_reload" class="browser-button" title="Reload">↻</button>
        <input id="urlfield" type="text" spellcheck="false" aria-label="Address" />
      </div>
      <div id="tab_content"></div>
    `
    windowContent.append(this.rightPanel)

    this.tabStrip = required<HTMLElement>("#electron_tabs")
    this.tabContent = required<HTMLElement>("#tab_content")
    this.address = required<HTMLInputElement>("#urlfield")
    this.backButton = required<HTMLButtonElement>("#browser_back")
    this.forwardButton = required<HTMLButtonElement>("#browser_forward")
    this.reloadButton = required<HTMLButtonElement>("#browser_reload")

    this.bindControls()
    this.bindLayout()
    this.bridge.tabs.onChanged((tabs) => this.render(tabs))
    this.bridge.tabs.getAll().then((tabs) => this.render(tabs))
  }

  setLeftCollapsed(collapsed: boolean): void {
    document.body.classList.toggle("electron-left-collapsed", collapsed)
    this.reportBounds()
  }

  private bindControls(): void {
    required<HTMLButtonElement>("#new_tab_btn").onclick = () => {
      this.bridge.tabs.create("about:blank", true)
    }
    this.backButton.onclick = () => {
      const active = this.activeTab()
      if (active) this.bridge.tabs.back(active.id)
    }
    this.forwardButton.onclick = () => {
      const active = this.activeTab()
      if (active) this.bridge.tabs.forward(active.id)
    }
    this.reloadButton.onclick = () => {
      const active = this.activeTab()
      if (!active) return
      if (active.loading) this.bridge.tabs.stop(active.id)
      else this.bridge.tabs.reload(active.id)
    }
    this.address.addEventListener("focus", () => this.address.select())
    this.address.addEventListener("input", () => this.address.setCustomValidity(""))
    this.address.addEventListener("keydown", async (event) => {
      if (event.key !== "Enter") return
      const active = this.activeTab()
      if (!active) return
      try {
        await this.bridge.tabs.navigate(active.id, this.address.value)
      } catch (error) {
        this.address.setCustomValidity(
          error instanceof Error ? error.message : String(error)
        )
        this.address.reportValidity()
      }
    })
  }

  private bindLayout(): void {
    this.leftPanel.style.flex = "0 0 42%"
    this.rightPanel.style.flex = "1 1 auto"

    let dragging = false
    this.splitter.addEventListener("pointerdown", (event) => {
      dragging = true
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
      this.splitter.releasePointerCapture(event.pointerId)
      this.reportBounds()
    })

    const observer = new ResizeObserver(() => this.reportBounds())
    observer.observe(this.tabContent)
    window.addEventListener("resize", () => this.reportBounds())
    requestAnimationFrame(() => this.reportBounds())
  }

  private render(tabs: ElectronTabState[]): void {
    this.tabs = tabs
    this.tabStrip.innerHTML = ""

    for (const tab of tabs) {
      const element = document.createElement("button")
      element.className = "electron-tab"
      element.classList.toggle("active", tab.active)
      element.setAttribute("role", "tab")
      element.setAttribute("aria-selected", String(tab.active))
      element.title = tab.title

      const title = document.createElement("span")
      title.className = "electron-tab-title"
      title.textContent = `${tab.audible ? "● " : ""}${tab.title || "New tab"}`
      element.append(title)

      const close = document.createElement("span")
      close.className = "electron-tab-close"
      close.textContent = "×"
      close.title = "Close tab"
      close.onclick = (event) => {
        event.stopPropagation()
        this.bridge.tabs.close(tab.id)
      }
      element.append(close)
      element.onclick = () => this.bridge.tabs.activate(tab.id)
      this.tabStrip.append(element)
    }

    const active = this.activeTab()
    if (active) {
      if (document.activeElement !== this.address) this.address.value = active.url
      this.backButton.disabled = !active.canGoBack
      this.forwardButton.disabled = !active.canGoForward
      this.reloadButton.textContent = active.loading ? "×" : "↻"
      this.reloadButton.title = active.loading ? "Stop" : "Reload"
    }
    this.reportBounds()
  }

  private activeTab(): ElectronTabState | undefined {
    return this.tabs.find((tab) => tab.active)
  }

  private reportBounds(): void {
    requestAnimationFrame(() => {
      const rect = this.tabContent.getBoundingClientRect()
      this.bridge.tabs.setBounds({
        x: Math.round(rect.left),
        y: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      })
    })
  }
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Required element not found: ${selector}`)
  return element
}
