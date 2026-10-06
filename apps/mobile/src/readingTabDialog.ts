import { mountRemoteTabs, type RemoteTabsPort } from "@once/ui-web"
import { ReadingTabs } from "./readingTabs"
import { attachReadingTabSwipe, ReadingTabSwipe } from "./readingTabSwipe"

/** An in-content dialog keeps the browser chrome available while choosing tabs. */
export class ReadingTabDialog {
  private readonly dialog = document.createElement("dialog")
  private readonly rows = document.createElement("div")
  private readonly count = document.createElement("button")
  private readonly undo = document.createElement("button")
  private readonly closeAll = document.createElement("button")
  private readonly total = document.createElement("span")
  private readonly undoBar = document.createElement("div")
  private readonly undoMessage = document.createElement("span")
  private readonly jumps = document.createElement("nav")
  private readonly status = document.createElement("span")
  private readonly swipe: ReadingTabSwipe
  // Rows rebuild only while visible and between gestures; tab updates are frequent.
  private rowsStale = true
  private remote?: HTMLElement
  /** Tabs other devices sent here, listed first. */
  private inbox?: HTMLElement
  private remoteVisible = false
  private tabMenu?: (tab: { id: string; url: string; title: string }, anchor: HTMLElement) => void

  constructor(private readonly tabs: ReadingTabs, actions: { select(id: string): void; create(): void; preview(): Promise<void> }) {
    this.count.type = "button"
    this.count.id = "reading_tabs"
    this.count.className = "button"
    this.count.setAttribute("aria-haspopup", "dialog")
    this.count.setAttribute("aria-controls", "reading_tabs_dialog")
    this.count.setAttribute("aria-expanded", "false")
    let opening = false
    this.count.onclick = async () => {
      if (this.dialog.open) { this.dialog.close(); return }
      if (opening) return
      opening = true
      // Capture while the native content is still visible; never block the UI indefinitely.
      await Promise.race([actions.preview(), new Promise(resolve => setTimeout(resolve, 250))])
      opening = false
      if (document.querySelector("#left_panel")?.getAttribute("active_panel") !== "reading") return
      this.dialog.show()
      this.renderRows()
      this.count.setAttribute("aria-expanded", "true")
      this.rows.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" })
    }
    document.querySelector("#reading_url_form")?.append(this.count)
    this.dialog.id = "reading_tabs_dialog"
    this.dialog.setAttribute("aria-labelledby", "reading_tabs_title")
    const header = document.createElement("header")
    const title = document.createElement("h2")
    title.id = "reading_tabs_title"
    title.textContent = "Tabs"
    this.total.className = "reading_tab_total"
    this.total.setAttribute("aria-hidden", "true")
    title.append(this.total)
    header.append(title)
    this.rows.className = "reading_tab_rows"
    this.swipe = attachReadingTabSwipe(this.rows, () => { if (this.rowsStale) this.renderRows() })
    this.rows.setAttribute("aria-label", "Open tabs")
    this.rows.setAttribute("role", "list")
    this.undo = button("Undo close", () => {
      tabs.undo()
      const selected = this.rows.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? this.rows.querySelector<HTMLButtonElement>("button")
      selected?.focus()
      this.announce("Closed tabs restored")
    })
    this.undo.textContent = "Undo"
    this.undo.setAttribute("aria-label", "Undo close")
    this.undoBar.className = "reading_tab_undo"
    this.undoBar.append(this.undoMessage, this.undo)
    const controls = document.createElement("div")
    controls.className = "reading_tab_controls"
    this.closeAll = button("Close all", () => this.confirmCloseAll())
    this.closeAll.setAttribute("aria-label", "Close all tabs")
    const create = button("", () => { this.dialog.close(); actions.create() })
    create.className = "button reading_tab_icon"
    create.setAttribute("aria-label", "New tab")
    create.title = "New tab"
    create.append(icon("plus"))
    const dismiss = button("", () => this.dialog.close())
    dismiss.className = "button reading_tab_icon"
    dismiss.setAttribute("aria-label", "Close tab view")
    dismiss.title = "Close tab view"
    dismiss.append(icon("x"))
    dismiss.autofocus = true
    controls.append(this.closeAll, create, dismiss)
    header.append(controls)
    this.status.setAttribute("role", "status")
    this.status.setAttribute("aria-live", "polite")
    this.status.className = "reading_tab_status"
    document.body.append(this.status)
    this.bindGroupNavigation()
    this.dialog.append(header, this.jumps, this.undoBar, this.rows)
    const content = document.querySelector("#reading_content")
    if (!content) throw new Error("Missing mobile reading content")
    content.append(this.dialog)
    this.dialog.addEventListener("close", () => {
      this.swipe.cancel()
      this.count.setAttribute("aria-expanded", "false")
      // Without tabs the panel stays put: its empty page takes an address.
      if (document.querySelector("#left_panel")?.getAttribute("active_panel") !== "reading") return
      if (document.activeElement === document.body || this.dialog.contains(document.activeElement)) this.count.focus()
    })
    document.addEventListener("once-panel-changed", event => {
      if ((event as CustomEvent<{ panel: string }>).detail.panel !== "reading") this.dialog.close()
    })
    document.querySelector("#reading_url")?.addEventListener("focus", () => this.dialog.close())
    document.querySelector("#reading_panel")?.addEventListener("click", event => {
      if (!(event.target instanceof Node) || event.composedPath().includes(content) || this.count.contains(event.target)) return
      this.dialog.close()
    })
    document.addEventListener("keydown", event => {
      // A menu over the tab view takes its own Escape.
      if (event.key !== "Escape" || event.defaultPrevented || !this.dialog.open || document.querySelector("dialog:modal")) return
      event.preventDefault()
      this.dialog.close()
    })
    this.rows.addEventListener("click", event => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab-id]")
      if (!target?.dataset.tabId || !target.parentElement) return
      // The lift after a long press opened the card's menu, not the tab.
      if (target.dataset.pressed === "menu") return
      if (target.dataset.action === "close") {
        const index = [...this.rows.children].indexOf(target.parentElement)
        this.undoMessage.textContent = "Tab closed"
        tabs.close(target.dataset.tabId)
        const row = this.rows.children[Math.min(index, this.rows.children.length - 1)]
        ;(row?.querySelector("button") ?? this.undo).focus()
        this.announce("Tab closed. Undo close is available.")
      } else {
        this.dialog.close()
        actions.select(target.dataset.tabId)
      }
    })
    tabs.subscribe(() => this.render())
  }

  announce(message: string): void { this.status.textContent = message }

  /**
   * A tab card's own menu (send it to another device, copy its link, close
   * it), on a long press or a right click: the card says what is sent.
   */
  enableTabMenu(open: (tab: { id: string; url: string; title: string }, anchor: HTMLElement) => void): void {
    this.tabMenu = open
    attachRowPress(this.rows, (select) => {
      const tab = this.tabs.tabs.find((entry) => entry.id === select.dataset.tabId)
      if (!tab) return
      const state = tab.session.snapshot()
      this.tabMenu?.({ id: tab.id, url: state.currentUrl, title: tab.title || state.story?.title || "" }, select)
    })
  }

  private bindGroupNavigation(): void {
    this.jumps.className = "reading_tab_jump"
    this.jumps.setAttribute("aria-label", "Tab groups")
    this.jumps.hidden = true
    this.jumps.append(button("This device", () => {
      this.rows.scrollTop = 0
      this.rows.querySelector<HTMLButtonElement>('button[data-action="select"]')?.focus({ preventScroll: true })
    }), button("Other devices", () => {
      this.remote?.scrollIntoView({ block: "start" })
      const target = [...this.remote?.querySelectorAll<HTMLElement>("input, button") ?? []].find((element) => element.getClientRects().length)
      target?.focus({ preventScroll: true })
    }))
  }

  /** Off, tab sync has no part in the tab view: no other devices, no sent tabs. */
  setOtherDevicesVisible(visible: boolean): void {
    if (this.remoteVisible === visible) return
    this.remoteVisible = visible
    this.jumps.hidden = !visible
    this.rowsStale = true
    this.renderRows()
  }

  /**
   * Other devices' tabs under this device's, in the same scrolling list.
   * Choosing one closes the tab view, like choosing a tab of this device.
   */
  showOtherDevices(port: RemoteTabsPort): void {
    if (this.remote) return
    const inbox = document.createElement("div")
    inbox.className = "reading_tab_inbox"
    inbox.setAttribute("role", "listitem")
    this.inbox = inbox
    const section = document.createElement("section")
    section.className = "reading_tab_remote"
    section.setAttribute("role", "listitem")
    section.setAttribute("aria-labelledby", "reading_tab_remote_title")
    section.dataset.testid = "reading-tabs-other-devices"
    const heading = document.createElement("h3")
    heading.id = "reading_tab_remote_title"
    heading.textContent = "Other devices"
    const view = document.createElement("div")
    section.append(heading, view)
    mountRemoteTabs(view, {
      ...port,
      open: (tab, background) => { if (!background) this.dialog.close(); port.open(tab, background) },
      openSent: port.openSent && ((id, background) => { if (!background) this.dialog.close(); port.openSent?.(id, background) }),
      openSettings: port.openSettings && ((page) => { this.dialog.close(); port.openSettings?.(page) })
    }, { inbox })
    this.remote = section
    this.rowsStale = true
    this.renderRows()
  }

  private confirmCloseAll(): void {
    let confirmed = false
    const confirmation = document.createElement("dialog")
    confirmation.className = "reading_tabs_confirm"
    confirmation.setAttribute("aria-label", "Close all tabs?")
    const message = document.createElement("p")
    message.textContent = "Close all tabs? You can undo this until you close another tab or restart Once."
    confirmation.append(message, button("Cancel", () => confirmation.close()), button("Close all tabs", () => {
      confirmed = true
      this.undoMessage.textContent = `${this.tabs.tabs.length} tabs closed`
      this.tabs.closeAll()
      confirmation.close()
      this.undo.focus()
      this.announce("All tabs closed. Undo close is available.")
    }))
    confirmation.addEventListener("close", () => {
      confirmation.remove()
      if (confirmed) this.undo.focus()
      else this.closeAll.focus()
    }, { once: true })
    document.body.append(confirmation)
    confirmation.showModal()
  }

  private render(): void {
    this.count.textContent = String(this.tabs.tabs.length)
    this.count.setAttribute("aria-label", `Tabs: ${this.tabs.tabs.length} open`)
    this.total.textContent = String(this.tabs.tabs.length)
    this.undoBar.hidden = !this.tabs.canUndo
    if (this.tabs.canUndo && !this.undoMessage.textContent) this.undoMessage.textContent = "Tabs closed"
    this.closeAll.disabled = !this.tabs.tabs.length
    this.rowsStale = true
    this.renderRows()
  }

  private renderRows(): void {
    if (!this.rowsStale || !this.dialog.open || this.swipe.active) return
    this.rowsStale = false
    // Retain focus across loading/title updates by identifying the row control.
    const focused = this.dialog.contains(document.activeElement) ? document.activeElement as HTMLElement : null
    const remoteFocus = focused && (this.remote?.contains(focused) || this.inbox?.contains(focused))
    const focusId = focused?.dataset.tabId
    const focusAction = focused?.dataset.action
    const scrollTop = this.rows.scrollTop
    this.rows.replaceChildren()
    // Sent here first, above this phone's own tabs; moved, not rebuilt.
    if (this.inbox && this.remoteVisible) this.rows.append(this.inbox)
    if (!this.tabs.tabs.length) {
      const empty = document.createElement("div")
      empty.className = "reading_tabs_empty"
      const heading = document.createElement("h3")
      heading.textContent = "No open tabs"
      const hint = document.createElement("p")
      hint.textContent = "Open a story or start a new tab. Your pages will be here when you return."
      empty.append(heading, hint)
      this.rows.append(empty)
    }
    for (const tab of this.tabs.tabs) {
      const state = tab.session.snapshot()
      const row = document.createElement("div")
      row.className = "reading_tab_row"
      row.setAttribute("role", "listitem")
      row.classList.toggle("reading_tab_selected", tab.id === this.tabs.activeId)
      const select = button("", () => undefined)
      select.dataset.tabId = tab.id
      select.dataset.action = "select"
      select.setAttribute("aria-current", String(tab.id === this.tabs.activeId))
      const title = document.createElement("strong")
      let hostname = ""
      let path = ""
      try {
        const url = new URL(state.currentUrl)
        hostname = url.hostname.replace(/^www\./, "")
        path = url.pathname === "/" ? "" : url.pathname
      } catch { /* empty tab */ }
      const pageTitle = tab.title || state.story?.title
      title.textContent = pageTitle || hostname || "New tab"
      const identity = document.createElement("span")
      identity.className = "reading_tab_identity"
      identity.textContent = hostname ? hostname[0].toUpperCase() : "+"
      if (tab.preview) {
        const preview = document.createElement("img")
        preview.src = tab.preview
        preview.alt = ""
        preview.className = "reading_tab_preview"
        identity.replaceChildren(preview)
      }
      if (tab.audio) {
        // Green while sound is coming from the tab; muted once it has stopped.
        const audio = document.createElement("span")
        audio.className = "reading_tab_audio"
        audio.dataset.audio = tab.audio
        audio.append(icon("volume"))
        identity.append(audio)
      }
      identity.setAttribute("aria-hidden", "true")
      const text = document.createElement("span")
      text.className = "reading_tab_text"
      const detail = document.createElement("span")
      detail.className = "reading_tab_detail"
      const address = pageTitle ? hostname : path || (hostname ? "Web page" : "Enter an address to get started")
      detail.textContent = [state.loadState === "loading" ? "Loading…" : state.loadState === "error" ? "Could not load page" : "", address].filter(Boolean).join(" · ")
      text.append(title, detail)
      if (tab.audio) {
        const audioStatus = document.createElement("span")
        audioStatus.className = "visually_hidden"
        audioStatus.textContent = tab.audio === "playing" ? "Playing audio" : "Played audio"
        text.append(audioStatus)
      }
      if (tab.id === this.tabs.activeId) {
        const current = document.createElement("span")
        current.className = "reading_tab_current"
        current.textContent = "Current tab"
        text.append(current)
      }
      select.append(identity, text)
      select.title = state.currentUrl || "New tab"
      const close = button("", () => undefined)
      close.append(icon("x"))
      close.dataset.tabId = tab.id
      close.dataset.action = "close"
      close.setAttribute("aria-label", `Close tab: ${title.textContent}`)
      const swipeHint = document.createElement("span")
      swipeHint.className = "reading_tab_swipe_hint"
      swipeHint.setAttribute("aria-hidden", "true")
      row.append(select, close, swipeHint)
      this.rows.append(row)
      if (focusId === tab.id) (focusAction === "close" ? close : select).focus({ preventScroll: true })
    }
    // Moved, not rebuilt: its filter and folded devices stay as they were.
    if (this.remote && this.remoteVisible) this.rows.append(this.remote)
    this.rows.scrollTop = scrollTop
    if (remoteFocus && focused.isConnected) focused.focus({ preventScroll: true })
  }
}

function button(label: string, action: () => void): HTMLButtonElement {
  const element = document.createElement("button")
  element.type = "button"
  element.className = "button"
  element.textContent = label
  element.onclick = action
  return element
}

function icon(name: "plus" | "x" | "volume"): HTMLElement {
  const element = document.createElement("span")
  element.className = `icon icon--chrome icon--${name}`
  element.setAttribute("aria-hidden", "true")
  return element
}

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE_PX = 10

/**
 * A touch held still on a tab card (or a right click) opens its menu. A
 * finger that moves is a swipe or a scroll, which the rows own.
 */
function attachRowPress(rows: HTMLElement, open: (select: HTMLButtonElement) => void): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let start = { x: 0, y: 0 }
  const cancel = () => { clearTimeout(timer); timer = undefined }
  const card = (target: EventTarget | null) =>
    target instanceof Element ? target.closest<HTMLButtonElement>('button[data-action="select"]') : null
  rows.addEventListener("pointerdown", (event) => {
    const select = card(event.target)
    if (!select || event.pointerType !== "touch" || !event.isPrimary) return
    delete select.dataset.pressed
    start = { x: event.clientX, y: event.clientY }
    cancel()
    timer = setTimeout(() => {
      timer = undefined
      select.dataset.pressed = "menu"
      setTimeout(() => { delete select.dataset.pressed }, 600)
      open(select)
    }, LONG_PRESS_MS)
  })
  rows.addEventListener("pointermove", (event) => {
    if (timer && Math.hypot(event.clientX - start.x, event.clientY - start.y) > MOVE_TOLERANCE_PX) cancel()
  })
  rows.addEventListener("pointerup", cancel)
  rows.addEventListener("pointercancel", cancel)
  rows.addEventListener("contextmenu", (event) => {
    const select = card(event.target)
    if (!select) return
    event.preventDefault()
    cancel()
    open(select)
  })
}
