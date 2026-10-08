import { domMenu, mountRemoteTabs, type RemoteTabsPort, type ShowMenu } from "@once/ui-web"
import { ReadingTabs } from "./readingTabs"
import { attachReadingTabSwipe, ReadingTabSwipe } from "./readingTabSwipe"

type TabGroup = "local" | "remote"

/** An in-content dialog keeps the browser chrome available while choosing tabs. */
export class ReadingTabDialog {
  private readonly dialog = document.createElement("dialog")
  private readonly rows = document.createElement("div")
  private readonly count = document.createElement("button")
  private readonly undo = document.createElement("button")
  private readonly more = document.createElement("button")
  private readonly title = document.createElement("h2")
  private readonly total = document.createElement("span")
  private readonly undoBar = document.createElement("div")
  private readonly undoMessage = document.createElement("span")
  private readonly groups = document.createElement("div")
  private readonly localTab = document.createElement("button")
  private readonly remoteTab = document.createElement("button")
  private readonly remotePanel = document.createElement("div")
  private readonly status = document.createElement("span")
  private readonly swipe: ReadingTabSwipe
  // Rows rebuild only while visible and between gestures; tab updates are frequent.
  private rowsStale = true
  private remote?: HTMLElement
  /** Tabs other devices sent here, listed first. */
  private inbox?: HTMLElement
  private remoteVisible = false
  /** This phone's tabs first, every time the view opens; the other group is one tap away. */
  private group: TabGroup = "local"
  private remoteCount = 0
  /** The tab sync port's menu (mobile's native sheet), once tab sync is set up. */
  private showMenu: ShowMenu = domMenu
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
      this.showGroup("local")
      this.renderRows()
      this.count.setAttribute("aria-expanded", "true")
      this.rows.querySelector('[aria-current="true"]')?.scrollIntoView({ block: "nearest" })
    }
    document.querySelector("#reading_url_form")?.append(this.count)
    this.dialog.id = "reading_tabs_dialog"
    this.dialog.setAttribute("aria-labelledby", "reading_tabs_title")
    const header = document.createElement("header")
    this.title.id = "reading_tabs_title"
    this.title.textContent = "Tabs"
    this.total.className = "reading_tab_total"
    this.total.setAttribute("aria-hidden", "true")
    this.title.append(this.total)
    this.buildGroups()
    header.append(this.title, this.groups)
    this.rows.className = "reading_tab_rows"
    this.rows.id = "reading_tab_rows"
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
    // New tab and Close all share one menu, so the groups keep the header to a single line.
    this.more = button("", () => void this.openMenu(actions.create))
    this.more.className = "button reading_tab_icon"
    this.more.setAttribute("aria-label", "More tab actions")
    this.more.setAttribute("aria-haspopup", "menu")
    this.more.title = "More tab actions"
    this.more.append(icon("more"))
    const dismiss = button("", () => this.dialog.close())
    dismiss.className = "button reading_tab_icon reading_tab_dismiss"
    dismiss.setAttribute("aria-label", "Close tab view")
    dismiss.title = "Close tab view"
    dismiss.append(icon("x"))
    dismiss.autofocus = true
    controls.append(this.more, dismiss)
    header.append(controls)
    this.status.setAttribute("role", "status")
    this.status.setAttribute("aria-live", "polite")
    this.status.className = "reading_tab_status"
    document.body.append(this.status)
    this.remotePanel.className = "reading_tab_remote_panel"
    this.remotePanel.id = "reading_tab_remote_panel"
    this.remotePanel.setAttribute("role", "tabpanel")
    this.remotePanel.setAttribute("aria-labelledby", this.remoteTab.id)
    this.remotePanel.hidden = true
    this.dialog.append(header, this.undoBar, this.rows, this.remotePanel)
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

  /**
   * "This phone" and "Other devices" as tabs in the header: one group shows
   * at a time, so this phone's tabs are never pushed below the others'.
   */
  private buildGroups(): void {
    this.groups.className = "reading_tab_groups"
    this.groups.setAttribute("role", "tablist")
    this.groups.setAttribute("aria-label", "Tab groups")
    this.groups.hidden = true
    const entries: Array<[HTMLButtonElement, TabGroup, string, string]> = [
      [this.localTab, "local", "This phone", "reading_tab_rows"],
      [this.remoteTab, "remote", "Other devices", "reading_tab_remote_panel"]
    ]
    for (const [tab, group, label, panel] of entries) {
      tab.type = "button"
      tab.id = `reading_tab_group_${group}`
      tab.className = "reading_tab_group"
      tab.setAttribute("role", "tab")
      tab.setAttribute("aria-controls", panel)
      const name = document.createElement("span")
      name.textContent = label
      const count = document.createElement("span")
      count.className = "reading_tab_group_count"
      tab.append(name, count)
      tab.addEventListener("click", () => this.showGroup(group))
    }
    // Arrow keys move between the two tabs, as in any tab list.
    this.groups.addEventListener("keydown", event => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
      event.preventDefault()
      const next = this.group === "local" ? "remote" : "local"
      this.showGroup(next)
      ;(next === "local" ? this.localTab : this.remoteTab).focus()
    })
    this.groups.append(this.localTab, this.remoteTab)
  }

  private showGroup(group: TabGroup): void {
    this.group = this.remoteVisible ? group : "local"
    const remote = this.group === "remote"
    for (const [tab, selected] of [[this.localTab, !remote], [this.remoteTab, remote]] as const) {
      tab.setAttribute("aria-selected", String(selected))
      tab.tabIndex = selected ? 0 : -1
    }
    this.rows.hidden = remote
    this.undoBar.classList.toggle("reading_tab_undo_away", remote)
    this.remotePanel.hidden = !remote
    if (!remote) {
      this.rowsStale = true
      this.renderRows()
    }
  }

  private updateGroups(): void {
    for (const [tab, label, count] of [[this.localTab, "This phone", this.tabs.tabs.length], [this.remoteTab, "Other devices", this.remoteCount]] as const) {
      const badge = tab.querySelector(".reading_tab_group_count")
      if (badge) badge.textContent = String(count)
      tab.setAttribute("aria-label", `${label}, ${count} tab${count === 1 ? "" : "s"}`)
    }
  }

  private async openMenu(create: () => void): Promise<void> {
    const items = [{ id: "new-tab", label: "New tab" }, ...(this.tabs.tabs.length ? [{ id: "close-all", label: "Close all tabs" }] : [])]
    const choice = await this.showMenu(this.more, items, "Tabs").catch(() => null)
    if (choice === "new-tab") { this.dialog.close(); create() }
    else if (choice === "close-all") this.confirmCloseAll()
  }

  /** Off, tab sync has no part in the tab view: no other devices, no sent tabs. */
  setOtherDevicesVisible(visible: boolean): void {
    if (this.remoteVisible === visible) return
    this.remoteVisible = visible
    // Without other devices there is nothing to switch to: the header keeps its plain title.
    this.groups.hidden = !visible
    this.title.classList.toggle("visually_hidden", visible)
    this.showGroup(this.group)
    this.rowsStale = true
    this.renderRows()
  }

  /**
   * Other devices' tabs in their own panel, one tap from this phone's.
   * Choosing one closes the tab view, like choosing a tab of this device.
   */
  showOtherDevices(port: RemoteTabsPort): void {
    if (this.remote) return
    if (port.showMenu) this.showMenu = port.showMenu
    const inbox = document.createElement("div")
    inbox.className = "reading_tab_inbox"
    inbox.setAttribute("role", "listitem")
    this.inbox = inbox
    const section = document.createElement("section")
    section.className = "reading_tab_remote"
    section.setAttribute("aria-label", "Other devices")
    section.dataset.testid = "reading-tabs-other-devices"
    mountRemoteTabs(section, {
      ...port,
      open: (tab, background) => { if (!background) this.dialog.close(); port.open(tab, background) },
      openSent: port.openSent && ((id, background) => { if (!background) this.dialog.close(); port.openSent?.(id, background) }),
      openSettings: port.openSettings && ((page) => { this.dialog.close(); port.openSettings?.(page) })
    }, { inbox, foldFilter: true })
    this.remote = section
    this.remotePanel.append(section)
    // The tab's count follows what the panel lists.
    const count = () => void port.load().then((state) => {
      this.remoteCount = (state.view?.devices ?? []).reduce((total, device) =>
        total + device.windows.reduce((sum, entry) => sum + entry.tabs.length, 0), 0)
      this.updateGroups()
    }, () => undefined)
    port.subscribe(count)
    count()
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
      else this.more.focus()
    }, { once: true })
    document.body.append(confirmation)
    confirmation.showModal()
  }

  private render(): void {
    this.count.textContent = String(this.tabs.tabs.length)
    this.count.setAttribute("aria-label", `Tabs: ${this.tabs.tabs.length} open`)
    this.total.textContent = String(this.tabs.tabs.length)
    this.updateGroups()
    this.undoBar.hidden = !this.tabs.canUndo
    if (this.tabs.canUndo && !this.undoMessage.textContent) this.undoMessage.textContent = "Tabs closed"
    this.rowsStale = true
    this.renderRows()
  }

  private renderRows(): void {
    if (!this.rowsStale || !this.dialog.open || this.swipe.active) return
    this.rowsStale = false
    // Retain focus across loading/title updates by identifying the row control.
    const focused = this.dialog.contains(document.activeElement) ? document.activeElement as HTMLElement : null
    const inboxFocus = focused && this.inbox?.contains(focused)
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
    this.rows.scrollTop = scrollTop
    if (inboxFocus && focused.isConnected) focused.focus({ preventScroll: true })
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

function icon(name: "more" | "x" | "volume"): HTMLElement {
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
