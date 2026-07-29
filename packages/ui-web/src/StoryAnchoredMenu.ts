/**
 * DOM context menu anchored to the element that opened it.
 *
 * Electron and the WebExtensions render story actions with their native menu
 * APIs; touch platforms have no such API, so this is the shared fallback. It
 * drops under the tapped row rather than sliding up from the bottom of the
 * screen, so the menu opens under the thumb that summoned it.
 *
 * `openAnchoredMenu` is the generic surface: the settings lists raise their
 * group and add menus through it so touch platforms keep exactly one menu
 * behaviour. `openStoryAnchoredMenu` is the story-specific wrapper over it.
 */

import {
  describeStoryMenu,
  executeStoryMenuAction,
  StoryMenuContext
} from "./StoryContextMenu"

/** Distance kept between the anchor and the panel, above or below. */
const ANCHOR_GAP_PX = 4
/** Distance kept between the panel and the edges of the boundary. */
const EDGE_GAP_PX = 8

export interface StoryAnchoredMenuOptions {
  /** Element the panel points at — normally the story row. */
  anchor: HTMLElement
  context: StoryMenuContext
  /**
   * Space reserved at the bottom of the viewport that the panel must not
   * cover, e.g. a fixed tab bar.
   */
  bottomInset?: number
  onClose?: () => void
}

/** One row of a generic anchored menu. */
export interface AnchoredMenuItem {
  id: string
  label: string
  enabled?: boolean
  /** Overrides the default `menu-${id}` test id. */
  testid?: string
  select(): void
}

export interface AnchoredMenuOptions {
  anchor: HTMLElement
  items: AnchoredMenuItem[]
  bottomInset?: number
  onClose?: () => void
}

let host: HTMLDivElement | null = null
let closeCurrent: (() => void) | null = null

export function isStoryAnchoredMenuOpen(): boolean {
  return host !== null && !host.hidden
}

export function closeStoryAnchoredMenu(): void {
  closeCurrent?.()
}

export function openStoryAnchoredMenu(
  options: StoryAnchoredMenuOptions
): void {
  const story = options.context.story
  openAnchoredMenu({
    anchor: options.anchor,
    bottomInset: options.bottomInset,
    onClose: options.onClose,
    items: describeStoryMenu(options.context)
      .filter((item) => item.visible)
      .map((item) => ({
        id: item.id,
        label: item.label,
        enabled: item.enabled,
        testid: `story-menu-${item.id}`,
        select: () => void executeStoryMenuAction(item.id, story)
      }))
  })
}

export function openAnchoredMenu(options: AnchoredMenuOptions): void {
  closeStoryAnchoredMenu()

  if (options.items.length === 0) return

  const element = ensureHost()
  const panel = requirePanel(element)
  panel.textContent = ""
  for (const item of options.items) {
    panel.append(actionRow(item))
  }

  element.hidden = false
  document.body.classList.add("once-anchored-menu-open")
  options.anchor.classList.add("menu_open")

  // Measure only once the panel is laid out; item count decides the height.
  position(panel, options.anchor, options.bottomInset ?? 0)

  const close = () => {
    if (closeCurrent !== close) return
    closeCurrent = null
    element.hidden = true
    document.body.classList.remove("once-anchored-menu-open")
    options.anchor.classList.remove("menu_open")
    window.removeEventListener("resize", reposition)
    document.removeEventListener("keydown", onKeyDown, true)
    options.onClose?.()
  }
  const reposition = () =>
    position(panel, options.anchor, options.bottomInset ?? 0)
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault()
      close()
    }
  }

  closeCurrent = close
  window.addEventListener("resize", reposition)
  document.addEventListener("keydown", onKeyDown, true)
}

function ensureHost(): HTMLDivElement {
  if (host) return host
  host = document.createElement("div")
  host.className = "once-anchored-menu"
  host.hidden = true

  const backdrop = document.createElement("div")
  backdrop.className = "once-anchored-menu-backdrop"
  backdrop.dataset.testid = "story-menu-backdrop"
  // pointerdown, not click: closing on the press keeps a tap outside the menu
  // from also activating whatever sits under it.
  backdrop.addEventListener("pointerdown", (event) => {
    event.preventDefault()
    closeStoryAnchoredMenu()
  })
  host.append(backdrop)

  const panel = document.createElement("div")
  panel.className = "once-anchored-menu-panel"
  panel.dataset.testid = "story-menu"
  panel.setAttribute("role", "menu")
  host.append(panel)

  document.body.append(host)
  return host
}

function requirePanel(element: HTMLDivElement): HTMLDivElement {
  const panel = element.querySelector<HTMLDivElement>(
    ".once-anchored-menu-panel"
  )
  if (!panel) throw new Error("The anchored menu panel is missing")
  return panel
}

function actionRow(item: AnchoredMenuItem): HTMLButtonElement {
  const row = document.createElement("button")
  row.type = "button"
  row.className = "once-anchored-menu-item"
  row.setAttribute("role", "menuitem")
  row.dataset.testid = item.testid || `menu-${item.id}`
  row.dataset.action = item.id
  row.textContent = item.label
  row.disabled = item.enabled === false
  row.addEventListener("click", () => {
    closeStoryAnchoredMenu()
    item.select()
  })
  return row
}

/**
 * Drops the panel below the anchor, right-aligned to it, and flips it above
 * when it would run into the reserved bottom inset.
 */
function position(
  panel: HTMLElement,
  anchor: HTMLElement,
  bottomInset: number
): void {
  const rect = anchor.getBoundingClientRect()
  const available = window.innerHeight - bottomInset
  panel.style.maxHeight = `${Math.max(
    0,
    available - EDGE_GAP_PX * 2
  )}px`
  panel.style.overflowY = "auto"
  const height = panel.offsetHeight
  const width = panel.offsetWidth

  let top = rect.bottom + ANCHOR_GAP_PX
  if (top + height > available - EDGE_GAP_PX) {
    top = rect.top - height - ANCHOR_GAP_PX
  }
  top = Math.max(
    EDGE_GAP_PX,
    Math.min(top, available - height - EDGE_GAP_PX)
  )

  const left = Math.max(
    EDGE_GAP_PX,
    Math.min(rect.right - width, window.innerWidth - width - EDGE_GAP_PX)
  )

  panel.style.top = `${Math.round(top)}px`
  panel.style.left = `${Math.round(left)}px`
}
