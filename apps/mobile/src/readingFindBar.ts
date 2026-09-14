import type { InAppBrowserSurface } from "@once/platform-mobile"
import { ReaderDocumentHost, ReadingSession, ReadingSessionState } from "@once/ui-web"
import { isReaderFindResponse, readerFindRequest } from "./readerFindProtocol"

/**
 * Raised on `document` to open the bar. The browser sheet beside the address
 * bar raises it (browserExtensionToolbar.ts spells the name out, since its
 * unit test loads that module without a module loader).
 */
export const FIND_IN_PAGE_REQUEST = "once-find-in-page-request"

/**
 * Find in page for the reading view, opened from the browser ⋮ sheet. The bar is shell
 * DOM along the bottom of the content; the page itself lives elsewhere, so
 * each mode has its own engine: Gecko's finder behind the native surface, and
 * a small runtime inside the sandboxed reader frame (see readerFind.ts).
 * Both answer with a count; the bar only holds the query and steps.
 */
export class ReadingFindBar {
  private readonly bar: HTMLElement
  private readonly input: HTMLInputElement
  private readonly count: HTMLElement
  private lastUrl = ""
  private lastMode = ""
  private lastLoadState = ""

  constructor(
    private readonly surface: InAppBrowserSurface,
    private readonly reader: ReaderDocumentHost,
    private readonly session: ReadingSession
  ) {
    this.bar = required("#reading_find_bar")
    this.input = required<HTMLInputElement>("#reading_find_field")
    this.count = required("#reading_find_count")
    this.bindControls()
    document.addEventListener(FIND_IN_PAGE_REQUEST, () => this.open())
    window.addEventListener("message", (event) => {
      if (!this.reader.isReaderWindow(event.source)) return
      if (!isReaderFindResponse(event.data) || event.data.query !== this.input.value) return
      this.showCount(event.data.current, event.data.total)
    })
    this.session.subscribe((state) => this.sync(state))
  }

  get isOpen(): boolean {
    return !this.bar.hidden
  }

  open(): void {
    const state = this.session.snapshot()
    if (!state.currentUrl) return
    this.bar.hidden = false
    this.input.focus()
    this.input.select()
    if (this.input.value) void this.find(true)
  }

  /** Closes the bar and drops the highlights; says whether it was open. */
  close(): boolean {
    if (!this.isOpen) return false
    this.bar.hidden = true
    this.input.blur()
    this.clearHighlights()
    this.setCount("")
    return true
  }

  private bindControls(): void {
    this.input.addEventListener("input", () => {
      if (this.input.value) void this.find(true)
      else {
        this.clearHighlights()
        this.setCount("")
      }
    })
    this.input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        void this.find(!event.shiftKey)
      } else if (event.key === "Escape") {
        event.preventDefault()
        this.close()
      }
    })
    required<HTMLButtonElement>("#reading_find_prev").onclick = () => void this.find(false)
    required<HTMLButtonElement>("#reading_find_next").onclick = () => void this.find(true)
    required<HTMLButtonElement>("#reading_find_close").onclick = () => this.close()
  }

  /**
   * One step. Both engines start over on a changed query and step on a
   * repeated one, so the bar sends the same request either way.
   */
  private async find(forward: boolean): Promise<void> {
    const query = this.input.value
    const state = this.session.snapshot()
    if (!query || !state.currentUrl) return
    if (state.mode === "reader") {
      this.reader.post(readerFindRequest({ type: "find", query, forward }))
      return
    }
    try {
      const result = await this.surface.findInPage(query, { forward })
      if (this.input.value !== query) return
      if (result) this.showCount(result.current, result.total)
      else this.setCount("Not available here")
    } catch {
      this.setCount("")
    }
  }

  private clearHighlights(): void {
    this.reader.post(readerFindRequest({ type: "clear" }))
    void this.surface.clearFind().catch(() => undefined)
  }

  private showCount(current: number, total: number): void {
    this.setCount(total ? `${current}/${total}` : "No matches")
    this.count.classList.toggle("no-matches", total === 0)
  }

  private setCount(text: string): void {
    this.count.textContent = text
    if (!text) this.count.classList.remove("no-matches")
  }

  /**
   * A navigation or a mode switch puts a different document under the query:
   * the old count is stale at once, and the search runs again when the new
   * document is ready. Closing the reading view closes the bar.
   */
  private sync(state: Readonly<ReadingSessionState>): void {
    const changed = state.currentUrl !== this.lastUrl || state.mode !== this.lastMode
    const becameReady = state.loadState === "ready" && this.lastLoadState !== "ready"
    this.lastUrl = state.currentUrl
    this.lastMode = state.mode
    this.lastLoadState = state.loadState
    if (!this.isOpen) return
    if (!state.currentUrl) {
      this.close()
      return
    }
    if (changed) this.setCount("")
    if ((changed || becameReady) && state.loadState === "ready" && this.input.value) {
      void this.find(true)
    }
  }
}

function required<T extends HTMLElement = HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector)
  if (!element) throw new Error(`Missing reading find control: ${selector}`)
  return element
}
