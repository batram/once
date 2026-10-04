import { PanelNavigation } from "@once/ui-web"
import { ReadingTabs } from "./readingTabs"

/** Native dialog semantics supply focus containment, Escape, and focus return. */
export class ReadingTabDialog {
  private readonly dialog = document.createElement("dialog")
  private readonly rows = document.createElement("div")
  private readonly count = document.createElement("button")
  private readonly undo = document.createElement("button")
  private readonly closeAll = document.createElement("button")
  private readonly status = document.createElement("span")

  constructor(private readonly tabs: ReadingTabs, actions: { select(id: string): void; create(): void }) {
    this.count.type = "button"
    this.count.id = "reading_tabs"
    this.count.className = "button"
    this.count.setAttribute("aria-haspopup", "dialog")
    this.count.onclick = () => this.dialog.showModal()
    document.querySelector("#reading_url_form")?.append(this.count)
    this.dialog.id = "reading_tabs_dialog"
    this.dialog.setAttribute("aria-labelledby", "reading_tabs_title")
    const header = document.createElement("header")
    const title = document.createElement("h2")
    title.id = "reading_tabs_title"
    title.textContent = "Tabs"
    const done = button("Done", () => this.dialog.close())
    header.append(title, done)
    this.rows.className = "reading_tab_rows"
    this.rows.setAttribute("aria-label", "Open tabs")
    const footer = document.createElement("footer")
    this.undo = button("Undo close", () => {
      tabs.undo()
      const selected = this.rows.querySelector<HTMLButtonElement>('[aria-current="true"]') ?? this.rows.querySelector<HTMLButtonElement>("button")
      selected?.focus()
      this.announce("Closed tabs restored")
    })
    this.closeAll = button("Close all", () => this.confirmCloseAll())
    footer.append(button("New tab", () => { this.dialog.close(); actions.create() }), this.closeAll, this.undo)
    this.status.setAttribute("role", "status")
    this.status.setAttribute("aria-live", "polite")
    this.status.className = "reading_tab_status"
    document.body.append(this.status)
    this.dialog.append(header, this.rows, footer)
    document.body.append(this.dialog)
    this.rows.addEventListener("click", event => {
      const target = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-tab-id]")
      if (!target?.dataset.tabId || !target.parentElement) return
      if (target.dataset.action === "close") {
        const index = [...this.rows.children].indexOf(target.parentElement)
        tabs.close(target.dataset.tabId)
        if (!tabs.tabs.length) PanelNavigation.open_panel("stories")
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
    const confirmation = document.createElement("dialog")
    confirmation.className = "reading_tabs_confirm"
    confirmation.setAttribute("aria-label", "Close all tabs?")
    const message = document.createElement("p")
    message.textContent = "Close all tabs? You can undo this until you close another tab or restart Once."
    confirmation.append(message, button("Cancel", () => confirmation.close()), button("Close all tabs", () => {
      this.tabs.closeAll()
      PanelNavigation.open_panel("stories")
      confirmation.close()
      this.undo.focus()
      this.announce("All tabs closed. Undo close is available.")
    }))
    confirmation.addEventListener("close", () => confirmation.remove(), { once: true })
    document.body.append(confirmation)
    confirmation.showModal()
  }

  private render(): void {
    this.count.textContent = String(this.tabs.tabs.length)
    this.count.setAttribute("aria-label", `Tabs: ${this.tabs.tabs.length} open`)
    this.undo.disabled = !this.tabs.canUndo
    this.closeAll.disabled = !this.tabs.tabs.length
    // Retain focus across loading/title updates by identifying the row control.
    const focused = this.dialog.contains(document.activeElement) ? document.activeElement as HTMLElement : null
    const focusId = focused?.dataset.tabId
    const focusAction = focused?.dataset.action
    this.rows.replaceChildren()
    if (!this.tabs.tabs.length) {
      const empty = document.createElement("p")
      empty.textContent = "No open tabs"
      this.rows.append(empty)
    }
    for (const tab of this.tabs.tabs) {
      const state = tab.session.snapshot()
      const row = document.createElement("div")
      row.className = "reading_tab_row"
      const select = button("", () => undefined)
      select.dataset.tabId = tab.id
      select.dataset.action = "select"
      select.setAttribute("aria-current", String(tab.id === this.tabs.activeId))
      const title = document.createElement("strong")
      title.textContent = tab.title || state.story?.title || state.currentUrl || "New tab"
      const detail = document.createElement("span")
      let address = state.currentUrl
      try { address = new URL(address).hostname } catch { /* empty tab */ }
      detail.textContent = [tab.id === this.tabs.activeId ? "Active" : "", address, state.loadState === "loading" ? "Loading…" : state.loadState === "error" ? "Could not load page" : ""].filter(Boolean).join(" · ")
      select.append(title, detail)
      const close = button("×", () => undefined)
      close.dataset.tabId = tab.id
      close.dataset.action = "close"
      close.setAttribute("aria-label", `Close tab: ${title.textContent}`)
      row.append(select, close)
      this.rows.append(row)
      if (focusId === tab.id) (focusAction === "close" ? close : select).focus()
    }
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
