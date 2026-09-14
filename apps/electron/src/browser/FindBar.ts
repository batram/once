import {
  ElectronBridge,
  ElectronFindResult,
  ElectronTabState
} from "@once/platform-electron/bridge"
import { getKeyboardDispatcher, setPaneFocus } from "@once/ui-web"

/**
 * Find in page: a bar along the bottom of the content pane that drives Chromium's own find
 * in the active tab. Chromium highlights and scrolls; the bar only holds the
 * query, counts the matches and steps through them.
 *
 * The bar lives in the shell renderer, not in the page, so it survives
 * navigation and cannot be styled away by a site. Its input sits inside the
 * content pane, so Ctrl+F while it holds focus is the browser command again
 * and simply reselects the query.
 */
export class FindBar {
  private readonly bar: HTMLElement
  private readonly input: HTMLInputElement
  private readonly count: HTMLElement
  private tabId: string | null = null
  private tabUrl = ""
  private tabs: ElectronTabState[] = []

  constructor(private readonly bridge: ElectronBridge) {
    this.bar = required<HTMLElement>("#find_bar")
    this.input = required<HTMLInputElement>("#find_field")
    this.count = required<HTMLElement>("#find_count")
    this.bindControls()
    this.bridge.tabs.onFoundInPage((id, result) => this.report(id, result))
    this.bridge.tabs.onChanged((tabs) => this.syncTabs(tabs))
    void this.bridge.tabs.getAll().then((tabs) => this.syncTabs(tabs))
    getKeyboardDispatcher().register("browser.find-in-page", () => this.show())
  }

  get isOpen(): boolean {
    return !this.bar.hidden
  }

  /**
   * Opens the bar on the active tab and hands it the keyboard. The chord
   * usually arrives from the page, where native focus still sits, so the shell
   * takes focus back first; a renderer-side focus() is ignored otherwise.
   */
  show(): void {
    const active = this.tabs.find((tab) => tab.active)
    if (!active) return
    this.bar.hidden = false
    this.tabId = active.id
    this.tabUrl = active.url
    void this.bridge.window.focusShell().then(() => {
      this.input.focus()
      this.input.select()
    })
    // A query left from last time is searched again rather than shown stale,
    // so reopening the bar lands on the first match straight away.
    if (this.input.value) this.find(true)
  }

  /** Closes the bar; the current match stays selected, the way browsers do it. */
  close(): void {
    if (!this.isOpen) return
    this.bar.hidden = true
    this.stop("keepSelection")
    this.setCount(null)
    setPaneFocus("browser")
    void this.bridge.tabs.focusContent()
  }

  private bindControls(): void {
    this.input.addEventListener("input", () => {
      if (this.input.value) this.find(true)
      else {
        this.stop("clearSelection")
        this.setCount(null)
      }
    })
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        this.step(!event.shiftKey)
      } else if (event.key === "Escape") {
        event.preventDefault()
        this.close()
      }
    })
    required<HTMLButtonElement>("#find_prev").onclick = () => this.step(false)
    required<HTMLButtonElement>("#find_next").onclick = () => this.step(true)
    required<HTMLButtonElement>("#find_close").onclick = () => this.close()
  }

  /** Steps to the neighbouring match of the running search. */
  private step(forward: boolean): void {
    if (!this.input.value) return
    this.find(false, forward)
    this.input.focus()
  }

  /** `newSession` for a changed query; false steps the session already running. */
  private find(newSession: boolean, forward = true): void {
    if (!this.tabId) return
    void this.bridge.tabs
      .findInPage(this.tabId, this.input.value, { forward, newSession })
      .catch(() => this.setCount(null))
  }

  private stop(action: "clearSelection" | "keepSelection"): void {
    if (!this.tabId) return
    void this.bridge.tabs.stopFindInPage(this.tabId, action).catch(() => undefined)
  }

  private report(id: string, result: ElectronFindResult): void {
    if (!this.isOpen || id !== this.tabId || !result.finalUpdate) return
    this.setCount(result.matches ? `${result.activeMatchOrdinal}/${result.matches}` : "No matches")
    this.count.classList.toggle("no-matches", result.matches === 0)
  }

  private setCount(text: string | null): void {
    this.count.textContent = text ?? ""
    if (text === null) this.count.classList.remove("no-matches")
  }

  /**
   * Follows the active tab. Switching tabs moves the search to the new tab,
   * and a navigation drops the count: Chromium has already cleared the
   * highlights, and the next keystroke or Enter searches the new page.
   */
  private syncTabs(tabs: ElectronTabState[]): void {
    this.tabs = tabs
    if (!this.isOpen) return
    const active = tabs.find((tab) => tab.active)
    if (!active) {
      this.close()
      return
    }
    if (active.id !== this.tabId) {
      this.stop("clearSelection")
      this.tabId = active.id
      this.tabUrl = active.url
      this.setCount(null)
      if (this.input.value) this.find(true)
    } else if (active.url !== this.tabUrl) {
      this.tabUrl = active.url
      this.setCount(null)
    }
  }
}

function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Required element not found: ${selector}`)
  return element
}
