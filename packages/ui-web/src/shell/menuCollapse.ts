// The sidebar menu's width and fold. Its right edge is a drag handle: the
// reader sets the width, it is remembered, and dragging it under the minimum
// folds the menu to its icon rail. A click on a folded menu's entry opens it
// again. The desktop also keeps the collapse buttons in the panel title bars,
// which fold the menu and tell the shell, so it can hide the whole sidebar.

const WIDTH_KEY = "once:menu-width"
const COLLAPSED_KEY = "once:menu-collapsed"

export const MENU_WIDTH = Object.freeze({ default: 89, min: 60, max: 240 })
/**
 * How far past the minimum the pointer must go before the menu folds. Under
 * the minimum the menu sticks at it, so the fold is a deliberate pull rather
 * than a snap the moment the edge crosses the line.
 */
export const FOLD_SLACK = 24

let announceCollapsed: ((collapsed: boolean) => void) | undefined
// The measured minimum, once the menu has been laid out open; see minimumWidth.
let measuredMinimum: number | undefined
// Whether the last fold came from a collapse button, whose host (the desktop)
// hides the whole sidebar for it; a drag folds the menu alone.
let collapsedByButton = false

/** Opens a collapsed sidebar, as a click on its menu would, for a panel that needs to be seen. */
export function expandMenu(): void {
  const menu = document.querySelector<HTMLElement>("#menu")
  if (!menu?.classList.contains("collapse")) return
  expand(menu)
}

export function bindMenuCollapseControls(
  onMenuCollapsedChanged?: (collapsed: boolean) => void,
  options: { resizable?: boolean } = {}
): void {
  const menu = document.querySelector<HTMLElement>("#menu")
  announceCollapsed = onMenuCollapsedChanged
  if (!menu) return

  document.querySelectorAll<HTMLElement>(".collapsebutton").forEach((element) => {
    element.onclick = () => {
      if (menu.classList.contains("collapse")) expand(menu)
      else {
        collapsedByButton = true
        setMenuCollapsed(menu, true)
        announceCollapsed?.(true)
      }
    }
  })

  menu.onclick = (event) => {
    if (!menu.classList.contains("collapse")) return
    const target = event.target
    if (!(target instanceof Element) || !target.closest(".sidebar_panel")) return
    expand(menu)
  }

  if (options.resizable) bindMenuResize(menu)
}

function expand(menu: HTMLElement): void {
  setMenuCollapsed(menu, false)
  store(COLLAPSED_KEY, null)
  if (collapsedByButton) announceCollapsed?.(false)
  collapsedByButton = false
}

function bindMenuResize(menu: HTMLElement): void {
  const handle = document.querySelector<HTMLElement>("#menu_resizer")
  if (!handle) return
  document.body.classList.add("menu-resizable")

  if (readCollapsed()) setMenuCollapsed(menu, true)
  applyWidth(menu, readWidth())
  // Fonts settle after the first layout; the name's width may grow with them.
  document.fonts?.ready.then(() => applyWidth(menu, menuWidth(menu))).catch(() => undefined)
  // Mounting twice (the shell binds early, the UI mount again) must not
  // attach a second set of drag handlers.
  if (handle.dataset.bound) return
  handle.dataset.bound = "true"

  let dragging = false
  // The width the drag started from: a drag that ends folded keeps it, so
  // the menu reopens as wide as it was rather than at the minimum it passed.
  let startWidth = readWidth()
  let minimum: number = MENU_WIDTH.min
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return
    dragging = true
    minimum = minimumWidth(menu)
    startWidth = menuWidth(menu)
    document.body.classList.add("menu-resizing")
    handle.setPointerCapture(event.pointerId)
    event.preventDefault()
  })
  handle.addEventListener("pointermove", (event) => {
    if (!dragging) return
    // The width excludes the menu's border, which draws the edge being dragged.
    const border = menu.offsetWidth - menu.clientWidth
    const width = Math.round(event.clientX - menu.getBoundingClientRect().left - border)
    const collapsed = width < minimum - FOLD_SLACK
    if (!collapsed) applyWidth(menu, Math.max(minimum, width))
    if (collapsed === menu.classList.contains("collapse")) return
    if (collapsed) setMenuCollapsed(menu, true)
    else expand(menu)
  })
  const finish = (event: PointerEvent): void => {
    if (!dragging) return
    dragging = false
    document.body.classList.remove("menu-resizing")
    if (handle.hasPointerCapture(event.pointerId)) handle.releasePointerCapture(event.pointerId)
    const collapsed = menu.classList.contains("collapse")
    store(COLLAPSED_KEY, collapsed ? "true" : null)
    if (collapsed) applyWidth(menu, startWidth)
    else store(WIDTH_KEY, String(menuWidth(menu)))
  }
  handle.addEventListener("pointerup", finish)
  handle.addEventListener("pointercancel", finish)
}

/**
 * The narrowest the menu may be before it folds: wide enough for every
 * built-in entry's name ("Settings", "Stories", …) to be read whole. The names
 * are hidden while the menu is folded, so a folded menu is opened for the
 * measurement within the same frame, and a measurement is kept once made.
 */
function minimumWidth(menu: HTMLElement): number {
  const folded = menu.classList.contains("collapse")
  if (folded && measuredMinimum !== undefined) return measuredMinimum
  if (folded) menu.classList.remove("collapse")
  try {
    const measured = measureHeadings(menu)
    if (measured > MENU_WIDTH.min) measuredMinimum = measured
    return measured
  } finally {
    if (folded) menu.classList.add("collapse")
  }
}

function measureHeadings(menu: HTMLElement): number {
  let minimum: number = MENU_WIDTH.min
  const headings = menu.querySelectorAll<HTMLElement>(
    ":scope > .sidebar_panel:not(.temporary_panel_menu, [hidden]) .heading"
  )
  headings.forEach((heading) => {
    const style = getComputedStyle(heading)
    const parts = [...heading.children].filter((child): child is HTMLElement => child instanceof HTMLElement)
    const content = parts.reduce((sum, part) => sum + Math.max(part.scrollWidth, part.offsetWidth), 0)
      + Math.max(0, parts.length - 1) * (Number.parseFloat(style.columnGap) || 0)
      + (Number.parseFloat(style.paddingLeft) || 0) + (Number.parseFloat(style.paddingRight) || 0)
    minimum = Math.max(minimum, Math.ceil(content))
  })
  return Math.min(minimum, MENU_WIDTH.max)
}

function menuWidth(menu: HTMLElement): number {
  const value = Number.parseFloat(menu.style.getPropertyValue("--menu-width"))
  return Number.isFinite(value) ? value : MENU_WIDTH.default
}

/** Sets the menu's open width, never narrower than its names need. */
function applyWidth(menu: HTMLElement, width: number): void {
  const minimum = Math.max(MENU_WIDTH.min, minimumWidth(menu))
  const clamped = Math.min(MENU_WIDTH.max, Math.max(minimum, width))
  menu.style.setProperty("--menu-width", `${clamped}px`)
}

function readWidth(): number {
  const value = Number.parseFloat(read(WIDTH_KEY) ?? "")
  return Number.isFinite(value) ? value : MENU_WIDTH.default
}

function readCollapsed(): boolean {
  return read(COLLAPSED_KEY) === "true"
}

function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}

function store(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key)
    else localStorage.setItem(key, value)
  } catch { /* remembered for this session only */ }
}

function setMenuCollapsed(menu: HTMLElement, collapsed: boolean): void {
  menu.classList.toggle("collapse", collapsed)
}
