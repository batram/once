import { PanelNavigation } from "@once/ui-web"
import { ReadingTabs } from "./readingTabs"

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
  private readonly status = document.createElement("span")

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
    this.dialog.append(header, this.undoBar, this.rows)
    const content = document.querySelector("#reading_content")
    if (!content) throw new Error("Missing mobile reading content")
    content.append(this.dialog)
    this.dialog.addEventListener("close", () => {
      this.count.setAttribute("aria-expanded", "false")
      if (document.querySelector("#left_panel")?.getAttribute("active_panel") !== "reading") return
      if (!this.tabs.tabs.length) { PanelNavigation.open_panel("stories"); return }
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
      if (event.key !== "Escape" || !this.dialog.open || document.querySelector("dialog:modal")) return
      event.preventDefault()
      this.dialog.close()
    })
    this.rows.addEventListener("click", event => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab-id]")
      if (!target?.dataset.tabId || !target.parentElement) return
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
    // Retain focus across loading/title updates by identifying the row control.
    const focused = this.dialog.contains(document.activeElement) ? document.activeElement as HTMLElement : null
    const focusId = focused?.dataset.tabId
    const focusAction = focused?.dataset.action
    const scrollTop = this.rows.scrollTop
    this.rows.replaceChildren()
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
      identity.setAttribute("aria-hidden", "true")
      const text = document.createElement("span")
      text.className = "reading_tab_text"
      const detail = document.createElement("span")
      detail.className = "reading_tab_detail"
      const address = pageTitle ? hostname : path || (hostname ? "Web page" : "Enter an address to get started")
      detail.textContent = [state.loadState === "loading" ? "Loading…" : state.loadState === "error" ? "Could not load page" : "", address].filter(Boolean).join(" · ")
      text.append(title, detail)
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
      row.append(select, close)
      this.rows.append(row)
      if (focusId === tab.id) (focusAction === "close" ? close : select).focus({ preventScroll: true })
    }
    this.rows.scrollTop = scrollTop
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

function icon(name: "plus" | "x"): HTMLElement {
  const element = document.createElement("span")
  element.className = `icon icon--chrome icon--${name}`
  element.setAttribute("aria-hidden", "true")
  return element
}
