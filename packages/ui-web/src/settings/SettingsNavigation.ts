import { open_panel } from "../shell/panelNavigation"

/** Location changes let transient interactions finish without owning history. */
export const SETTINGS_LOCATION_CHANGED = "once:settings-location-changed"

export interface SettingsPanelOptions {
  scanPairingCode?: () => Promise<string | null>
}

/** Views describe locations; only SettingsNavigation owns visit history. */
export interface SettingsPage {
  key: string
  title: () => string
  show(): void
  /** Detach a draft without saving it. Mounted pages need no leave callback. */
  leave?(): void
  /** Deleted items and drafts whose underlying records changed cannot replay. */
  valid?(): boolean
}

interface Visit {
  section: string | null
  root?: HTMLElement
  page?: SettingsPage
  focus?: HTMLElement
  scroll?: Array<[HTMLElement, number]>
}

interface SettingsNavigationHost {
  section(): string | null
  /** Render only: this must not create another visit. */
  show(section: string | null): void
  label(section: string | null): string
  back: HTMLButtonElement
  resetIndex?(): void
}

const navigations = new WeakMap<Document, SettingsNavigation>()
const overviews = new WeakMap<Document, Map<HTMLElement, () => void>>()

export function registerSettingsOverview(root: HTMLElement, show: () => void): void {
  const views = overviews.get(document) ?? new Map<HTMLElement, () => void>()
  views.set(root, show)
  overviews.set(document, views)
}

/**
 * Open a page through the shared history, including search and deep links.
 * `replace` makes the page take the current visit's place instead of adding
 * one: a link that first switches section and then opens a page within it
 * is one step to the reader, and Back must go to where the link was.
 */
export function openSettingsPage(root: HTMLElement, page: SettingsPage, alreadyShown = false, replace = false): void {
  const navigation = navigations.get(document)
  if (navigation) navigation.openPage(root, page, alreadyShown, replace)
  else if (!alreadyShown) page.show()
}

/** Save/Cancel completes an editor: its abandoned draft must not replay. */
export function completeSettingsPage(root: HTMLElement): void { navigations.get(document)?.complete(root) }
export function invalidateSettingsPages(): void { navigations.get(document)?.prune() }
/** One history for the index, sections and every nested settings page. */
export class SettingsNavigation {
  private current: Visit
  private backHistory: Visit[] = []
  private forwardHistory: Visit[] = []
  private replaying = false
  private returnPanel = "stories"
  private forwardToSettings = false

  constructor(private host: SettingsNavigationHost) {
    this.current = { section: host.section() }
    navigations.set(document, this)
    // The button goes up the tree; the mouse and swipe gestures below walk the history.
    host.back.onclick = () => this.up()
    document.addEventListener("once-settings-index-requested", () => { this.open(null); host.resetIndex?.() })
    document.addEventListener("once-settings-navigate", event => {
      const direction = (event as CustomEvent<{ direction: string }>).detail.direction
      if (direction !== "back" && direction !== "forward") return
      if (!this.active() && !(direction === "forward" && this.forwardToSettings)) return
      event.preventDefault()
      this.navigate(direction)
    })
    document.querySelector("#settings_panel")?.addEventListener("keydown", event => {
      const key = event as KeyboardEvent
      if (key.key !== "Escape" || key.defaultPrevented ||
          (key.target instanceof Element && key.target.matches("input,textarea,select"))) return
      key.preventDefault()
      key.stopPropagation()
      this.up()
    })
    document.addEventListener("once-panel-changed", event => {
      const { panel, previous } = (event as CustomEvent<{ panel: string; previous: string | null }>).detail
      if (panel === previous || this.replaying) return
      this.forwardToSettings = false
      if (panel !== "settings") return
      this.returnPanel = previous || "stories"
      this.backHistory = this.current.section === null ? [] : [{ section: null }]
      this.forwardHistory = []
      this.updateBack()
    })
  }

  open(section: string | null): void { this.visit({ section }) }

  /**
   * Up the tree: a page to its section, a section to the index, the index out
   * of Settings. Where up is also the previous visit, the move retraces it so
   * Forward still reopens what was left; otherwise it is a visit of its own,
   * which the gestures can then retrace. Labelled by where it goes, so the
   * button reads the same however the page was reached.
   */
  up(): void {
    if (!this.active()) return
    const parent = this.parentOf(this.current)
    if (!parent) { this.leave(); return }
    const previous = [...this.backHistory].reverse().find(visit => this.valid(visit))
    if (previous && previous.section === parent.section && !previous.page) this.navigate("back")
    else this.visit(parent)
  }

  private parentOf(visit: Visit): Visit | null {
    if (visit.page) return { section: visit.section }
    return visit.section === null ? null : { section: null }
  }

  private leave(): void {
    this.capture()
    this.replaying = true
    try { open_panel(this.returnPanel) } finally { this.replaying = false }
    this.forwardToSettings = true
  }

  openPage(root: HTMLElement, page: SettingsPage, alreadyShown = false, replace = false): void {
    const section = root.closest<HTMLElement>("[data-settings-section]")?.dataset.settingsSection
    if (!section) { if (!alreadyShown) page.show(); return }
    this.visit({ section, root, page }, alreadyShown, replace)
  }

  private visit(next: Visit, alreadyShown = false, replace = false): void {
    if (!this.valid(next)) return
    if (next.section === this.current.section && next.root === this.current.root && next.page?.key === this.current.page?.key) {
      this.updateBack()
      return
    }
    this.capture()
    if (!replace) this.backHistory.push(this.current)
    this.forwardHistory = []
    this.apply(next, alreadyShown)
  }

  navigate(direction: "back" | "forward"): void {
    if (!this.active()) {
      if (direction !== "forward" || !this.forwardToSettings) return
      this.replaying = true
      try { open_panel("settings") } finally { this.replaying = false }
      this.forwardToSettings = false
      this.apply(this.current)
      return
    }
    const from = direction === "back" ? this.backHistory : this.forwardHistory
    const to = direction === "back" ? this.forwardHistory : this.backHistory
    while (from.length) {
      const next = from.pop()
      if (!next) return
      if (!this.valid(next)) continue
      this.capture()
      to.push(this.current)
      this.apply(next)
      return
    }
    if (direction === "back") this.leave()
  }

  complete(root: HTMLElement): void {
    if (this.replaying || this.current.root !== root) return
    const page = this.current.page
    this.backHistory = this.backHistory.filter(visit => visit.page !== page)
    this.forwardHistory = this.forwardHistory.filter(visit => visit.page !== page)
    const previous = this.backHistory.at(-1)
    this.current = previous?.section === this.current.section && !previous.page
      ? this.backHistory.pop() ?? { section: this.current.section }
      : { section: this.current.section }
    this.updateBack()
  }

  prune(): void {
    if (this.replaying) return
    this.backHistory = this.backHistory.filter(visit => this.valid(visit))
    this.forwardHistory = this.forwardHistory.filter(visit => this.valid(visit))
    if (!this.valid(this.current)) this.apply({ section: this.current.section })
    this.updateBack()
  }

  private valid(visit: Visit): boolean { return visit.page?.valid?.() !== false }
  private active(): boolean { return document.querySelector("#left_panel")?.getAttribute("active_panel") === "settings" }

  private capture(): void {
    this.current.focus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined
    this.current.scroll = Array.from(document.querySelectorAll<HTMLElement>("#settings_panel, #settings_index, .settings_section.active"))
      .map(element => [element, element.scrollTop])
  }

  private apply(next: Visit, alreadyShown = false): void {
    this.replaying = true
    try {
      if (!alreadyShown) this.current.page?.leave?.()
      this.current = next
      if (!alreadyShown) {
        this.host.show(next.section)
        for (const [root, show] of overviews.get(document) ?? []) {
          if (root.closest<HTMLElement>("[data-settings-section]")?.dataset.settingsSection === next.section) show()
        }
        next.page?.show()
      }
      this.updateBack()
      document.dispatchEvent(new CustomEvent(SETTINGS_LOCATION_CHANGED))
    } finally { this.replaying = false }
    if (!alreadyShown && (next.focus || next.scroll)) requestAnimationFrame(() => {
      if (this.current !== next || !this.active()) return
      if (next.focus?.isConnected && !next.focus.closest("[hidden]")) next.focus.focus({ preventScroll: true })
      for (const [element, top] of next.scroll ?? []) element.scrollTop = top
    })
  }

  private updateBack(): void {
    const parent = this.parentOf(this.current)
    this.host.back.textContent = parent ? this.host.label(parent.section) : "Back"
  }
}
