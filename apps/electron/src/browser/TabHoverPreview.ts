import { ElectronBridge, ElectronTabHoverTheme, ElectronTabState } from "@once/platform-electron/bridge"

/** How long the pointer rests on a tab before its card opens. */
const OPEN_DELAY_MS = 500
/** Moving on from one card to the next within this long skips the delay. */
const WARM_MS = 300

/**
 * Opens the preview card for the tab under the pointer, the way other
 * browsers do: after a short rest, then straight away while sliding along
 * the strip. Clicking, dragging or scrolling puts it away until the pointer
 * moves on to another tab.
 */
export class TabHoverPreview {
  private hoveredId: string | null = null
  private shownId: string | null = null
  private shown: ElectronTabState | null = null
  private tabs: ElectronTabState[] = []
  private suppressedId: string | null = null
  private timer: number | undefined
  private hiddenAt = 0

  constructor(
    private readonly bridge: ElectronBridge,
    private readonly strip: HTMLElement
  ) {
    strip.addEventListener("pointerover", (event) => this.hover(tabIdAt(event.target)))
    strip.addEventListener("pointerleave", () => this.leave())
    for (const type of ["pointerdown", "wheel", "dragstart", "contextmenu"]) {
      strip.addEventListener(type, () => this.dismiss(), { passive: true })
    }
    window.addEventListener("blur", () => this.leave())
  }

  private hover(id: string | null): void {
    if (!id || id === this.hoveredId) return
    this.hoveredId = id
    if (this.suppressedId !== id) this.suppressedId = null
    window.clearTimeout(this.timer)
    if (this.suppressedId) return
    const warm = this.shownId !== null || performance.now() - this.hiddenAt < WARM_MS
    if (warm) this.open(id)
    else this.timer = window.setTimeout(() => this.open(id), OPEN_DELAY_MS)
  }

  private leave(): void {
    this.hoveredId = null
    this.suppressedId = null
    this.close()
  }

  private dismiss(): void {
    this.suppressedId = this.hoveredId
    this.close()
  }

  private close(): void {
    window.clearTimeout(this.timer)
    if (this.shownId === null) return
    this.shownId = null
    this.shown = null
    this.hiddenAt = performance.now()
    void this.bridge.tabs.hideHoverCard()
  }

  private open(id: string): void {
    const element = this.strip.querySelector<HTMLElement>(`[data-tab-id="${CSS.escape(id)}"]`)
    if (!element || this.hoveredId !== id) return
    const rect = element.getBoundingClientRect()
    this.shownId = id
    this.shown = this.tabs.find((tab) => tab.id === id) ?? null
    void this.bridge.tabs.showHoverCard(
      id,
      { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      this.theme()
    ).catch(() => {
      if (this.shownId === id) this.close()
    })
  }

  /** The shell hands over every tab list it renders. A title arriving while
   * the card is open refreshes it; a tab that went away takes its card along. */
  update(tabs: ElectronTabState[]): void {
    this.tabs = tabs
    if (!this.shownId) return
    const tab = tabs.find((candidate) => candidate.id === this.shownId)
    if (!tab) return this.close()
    const previous = this.shown
    this.shown = tab
    if (!previous || previous.title !== tab.title || previous.url !== tab.url || previous.active !== tab.active) {
      this.open(tab.id)
    }
  }

  private theme(): ElectronTabHoverTheme {
    const style = getComputedStyle(this.strip)
    const value = (name: string, fallback: string) => style.getPropertyValue(name).trim() || fallback
    return {
      background: value("--read-bg-color", "#ffffff"),
      foreground: value("--text-high-color", "#1f1f1f"),
      muted: value("--text-color", "#5f6368"),
      border: value("--border-high-color", "#dadce0")
    }
  }
}

function tabIdAt(target: EventTarget | null): string | null {
  if (!(target instanceof Element)) return null
  return target.closest<HTMLElement>(".electron-tab")?.dataset.tabId ?? null
}
