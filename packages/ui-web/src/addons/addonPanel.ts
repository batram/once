// The Once panel as a place for a page's add-on conversation: beside the page
// it is about, rather than in a tab that covers it. Chosen per add-on in its
// settings, it is mostly reached from a page's context menu. The panel and its
// menu button exist only while a conversation is shown there, and go away
// when it is closed or the conversation ends.
import { expandMenu } from "../shell/menuCollapse"
import { active_flash_panel, open_panel } from "../shell/panelNavigation"
import type { AddonConversationHandle, AddonConversationSurface } from "./AddonTrays"
import { AddonConversationPort, mountAddonConversation } from "./conversationPage"
import { pageAddonActions } from "./pageAddons"

/** The `active_panel` name of the add-on conversation panel. */
export const ADDON_PANEL = "addon"

interface Shown {
  button: HTMLButtonElement
  panel: HTMLElement
  /** The title bar; a sibling of the panels so it can sit above the matching story. */
  bar: HTMLElement
  title: HTMLElement
  body: HTMLElement
  unmount: () => void
  /** The panel to return to on close. */
  previous: string
}

/**
 * The add-on as its menu button names it: the short name it declares, its name
 * when that fits, or the initials of a longer one ("What? Wait, who, why?" is WWWW).
 */
export function menuName(addon: { name: string; shortName?: string }): string {
  if (addon.shortName) return addon.shortName
  if (addon.name.length <= 12) return addon.name
  return (addon.name.match(/[\p{L}\p{N}]+/gu) ?? []).map(word => word[0].toUpperCase()).join("").slice(0, 6) || addon.name.slice(0, 12)
}

function icon(name: string): HTMLElement {
  const element = document.createElement("span")
  element.className = `icon icon--chrome icon--${name}`
  element.setAttribute("aria-hidden", "true")
  return element
}

/** The panel's button in the menu and the panel itself, after the shell's own. */
function build(close: () => void): Omit<Shown, "unmount" | "previous"> | null {
  const menu = document.querySelector<HTMLElement>("#menu")
  const main = document.querySelector<HTMLElement>("#left_main")
  if (!menu || !main) return null
  const button = document.createElement("button")
  button.type = "button"
  button.className = "button sidebar_panel"
  button.id = "addon_menu_btn"
  button.dataset.panel = ADDON_PANEL
  button.dataset.testid = "addon-panel-menu"
  const heading = document.createElement("span")
  heading.className = "heading"
  heading.append(icon("ai-question"), document.createElement("p"))
  button.append(heading)
  button.addEventListener("click", () => open_panel(ADDON_PANEL))
  active_flash_panel(button)
  // Under the story filters, above the status dock that the menu pushes to its bottom.
  menu.insertBefore(button, menu.querySelector(":scope > #status_dock"))
  const panel = document.createElement("div")
  panel.id = "addon_panel"
  panel.className = "panel"
  panel.dataset.panel = ADDON_PANEL
  panel.dataset.testid = "addon-panel"
  const bar = document.createElement("div")
  bar.id = "addon_panel_bar"
  bar.className = "bar toolbar panel_titlebar"
  const title = document.createElement("div")
  title.className = "addon_panel_title"
  const closeButton = document.createElement("button")
  closeButton.type = "button"
  closeButton.className = "button button--icon bar_btn addon_panel_close"
  closeButton.setAttribute("aria-label", "Close")
  closeButton.dataset.testid = "addon-panel-close"
  closeButton.append(icon("x"))
  closeButton.addEventListener("click", close)
  bar.append(title, closeButton)
  const body = document.createElement("div")
  body.className = "addon_panel_body"
  panel.append(body)
  main.append(bar, panel)
  return { button, panel, bar, title, body }
}

/** Shows page conversations in the Once panel; the surface `mountAddons` opens the panel choice with. */
export function addonPanelConversations(): AddonConversationSurface {
  let shown: Shown | null = null
  // Closing returns to the panel the reader came from on their latest visit.
  document.addEventListener("once-panel-changed", event => {
    const { panel, previous } = (event as CustomEvent<{ panel: string; previous: string | null }>).detail
    if (shown && panel === ADDON_PANEL && previous && previous !== ADDON_PANEL) shown.previous = previous
  })
  const close = (): void => {
    if (!shown) return
    const { button, panel, bar, unmount, previous } = shown
    shown = null
    unmount()
    const active = document.querySelector("#left_panel")?.getAttribute("active_panel")
    button.remove()
    bar.remove()
    panel.remove()
    if (active === ADDON_PANEL) open_panel(previous)
  }
  const port = (handle: AddonConversationHandle): AddonConversationPort => ({
    subscribe(listener) {
      listener(handle.snapshot(), true)
      // A conversation that ended (the add-on was reset, disabled or removed) takes its panel along.
      return handle.subscribe(snapshot => { if (snapshot) listener(snapshot, true); else queueMicrotask(close) })
    },
    send: command => handle.send(command)
  })
  return {
    label: "Show in the Once panel",
    open(handle) {
      const active = document.querySelector("#left_panel")?.getAttribute("active_panel") ?? "stories"
      // One conversation at a time: a new one takes the place of the last.
      shown?.unmount()
      const parts = shown ?? build(close)
      if (!parts) return
      const snapshot = handle.snapshot()
      const action = pageAddonActions("menu").find(item => item.id.startsWith(`addon:${snapshot.addon.id}/`))
      parts.button.querySelector(".icon")?.replaceWith(icon(action?.icon ?? "ai-question"))
      const label = parts.button.querySelector("p")
      if (label) label.textContent = menuName(snapshot.addon)
      parts.button.title = snapshot.addon.name
      parts.title.textContent = snapshot.addon.name
      shown = { ...parts, unmount: mountAddonConversation(parts.body, port(handle), true),
        previous: shown?.previous ?? (active === ADDON_PANEL ? "stories" : active) }
      expandMenu()
      open_panel(ADDON_PANEL)
    }
  }
}
