// A panel that exists only while it shows something: a page's add-on
// conversation, a story's comments. Its menu button and the panel come and go
// together. Layout matches the other panels: its title bar with a close button,
// then the story matching the page (the stories panel shrinks to its selected
// story), then its body. Closing returns to the last panel the reader had
// open that still exists (see panelNavigation).
import { expandMenu } from "./menuCollapse"
import { active_flash_panel, closePanel, open_panel } from "./panelNavigation"

export function panelIcon(name: string): HTMLElement {
  const element = document.createElement("span")
  element.className = `icon icon--chrome icon--${name}`
  element.setAttribute("aria-hidden", "true")
  return element
}

export class TemporaryPanel {
  private constructor(
    readonly name: string,
    readonly button: HTMLButtonElement,
    /** The title bar; a sibling of the panels so it can sit above the matching story. */
    readonly bar: HTMLElement,
    readonly title: HTMLElement,
    readonly panel: HTMLElement,
    readonly body: HTMLElement
  ) {}

  /**
   * The panel's button in the menu and the panel itself, after the shell's own.
   * `name` is its `active_panel` value and prefixes its ids and test ids.
   */
  static create(name: string, close: () => void): TemporaryPanel | null {
    const menu = document.querySelector<HTMLElement>("#menu")
    const main = document.querySelector<HTMLElement>("#left_main")
    if (!menu || !main) return null
    const button = document.createElement("button")
    button.type = "button"
    button.className = "button sidebar_panel temporary_panel_menu"
    button.id = `${name}_menu_btn`
    button.dataset.panel = name
    button.dataset.testid = `${name}-panel-menu`
    const heading = document.createElement("span")
    heading.className = "heading"
    heading.append(panelIcon("ai-question"), document.createElement("p"))
    button.append(heading)
    button.addEventListener("click", () => open_panel(name))
    active_flash_panel(button)
    // Under the story filters, above the status dock that the menu pushes to its bottom.
    menu.insertBefore(button, menu.querySelector(":scope > #status_dock"))
    const panel = document.createElement("div")
    panel.id = `${name}_panel`
    panel.className = "panel temporary_panel"
    panel.dataset.panel = name
    panel.dataset.testid = `${name}-panel`
    const bar = document.createElement("div")
    bar.id = `${name}_panel_bar`
    bar.className = "bar toolbar panel_titlebar temporary_panel_bar"
    const title = document.createElement("div")
    title.className = "temporary_panel_title"
    const closeButton = barButton("x", "Close", close)
    closeButton.dataset.testid = `${name}-panel-close`
    bar.append(title, closeButton)
    const body = document.createElement("div")
    body.className = "temporary_panel_body"
    panel.append(body)
    main.append(bar, panel)
    return new TemporaryPanel(name, button, bar, title, panel, body)
  }

  /** The menu button's icon and short label, and the name the title bar and tooltip give in full. */
  label(icon: string, short: string, full: string): void {
    this.button.querySelector(".icon")?.replaceWith(panelIcon(icon))
    const label = this.button.querySelector("p")
    if (label) label.textContent = short
    this.button.title = full
    this.title.textContent = full
  }

  /** A button in the title bar, before its close button. */
  addBarButton(button: HTMLButtonElement): void {
    this.bar.insertBefore(button, this.bar.lastElementChild)
  }

  show(): void {
    expandMenu()
    open_panel(this.name)
  }

  /** Takes the panel away; when it was showing, the last panel still open takes its place. */
  remove(): void {
    if (!this.panel.isConnected) return
    this.button.remove()
    this.bar.remove()
    this.panel.remove()
    closePanel(this.name)
  }
}

export function barButton(icon: string, label: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "button button--icon bar_btn temporary_panel_btn"
  button.title = label
  button.setAttribute("aria-label", label)
  button.append(panelIcon(icon))
  button.addEventListener("click", run)
  return button
}
