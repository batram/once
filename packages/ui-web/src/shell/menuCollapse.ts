// The sidebar menu's width. On the desktop its right edge is a drag handle:
// the reader sets the width, it is remembered, and dragging it under the
// minimum folds the menu to its icon rail. A click on a folded menu's entry
// opens it again. The extensions keep the fixed width and never fold.

const WIDTH_KEY = "once:menu-width"
const COLLAPSED_KEY = "once:menu-collapsed"

export const MENU_WIDTH = Object.freeze({ default: 89, min: 60, max: 240 })

let announceCollapsed: ((collapsed: boolean) => void) | undefined

/** Opens a collapsed sidebar, as a click on its menu would, for a panel that needs to be seen. */
export function expandMenu(): void {
  const menu = document.querySelector<HTMLElement>("#menu")
  if (!menu?.classList.contains("collapse")) return
  setMenuCollapsed(menu, false)
  announceCollapsed?.(false)
}

export function bindMenuCollapseControls(
  onMenuCollapsedChanged?: (collapsed: boolean) => void,
  options: { resizable?: boolean } = {}
): void {
  const menu = document.querySelector<HTMLElement>("#menu")
  announceCollapsed = onMenuCollapsedChanged
  if (!menu) return

  menu.onclick = (event) => {
    if (!menu.classList.contains("collapse")) return
    const target = event.target
    if (!(target instanceof Element) || !target.closest(".sidebar_panel")) return
    setMenuCollapsed(menu, false)
    onMenuCollapsedChanged?.(false)
  }

  if (options.resizable) bindMenuResize(menu, onMenuCollapsedChanged)
}

function bindMenuResize(
  menu: HTMLElement,
  onMenuCollapsedChanged?: (collapsed: boolean) => void
): void {
  const handle = document.querySelector<HTMLElement>("#menu_resizer")
  if (!handle) return
  document.body.classList.add("menu-resizable")

  applyWidth(menu, readWidth())
  if (readCollapsed()) {
    setMenuCollapsed(menu, true)
    onMenuCollapsedChanged?.(true)
  }
  // Mounting twice (the shell binds early, the UI mount again) must not
  // attach a second set of drag handlers.
  if (handle.dataset.bound) return
  handle.dataset.bound = "true"

  let dragging = false
  // The width the drag started from: a drag that ends folded keeps it, so
  // the menu reopens as wide as it was rather than at the minimum it passed.
  let startWidth = readWidth()
  handle.addEventListener("pointerdown", (event) => {
    if (event.button !== 0) return
    dragging = true
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
    const collapsed = width < MENU_WIDTH.min
    if (!collapsed) applyWidth(menu, width)
    if (collapsed !== menu.classList.contains("collapse")) {
      setMenuCollapsed(menu, collapsed)
      onMenuCollapsedChanged?.(collapsed)
    }
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

function menuWidth(menu: HTMLElement): number {
  const value = Number.parseFloat(menu.style.getPropertyValue("--menu-width"))
  return Number.isFinite(value) ? value : MENU_WIDTH.default
}

function applyWidth(menu: HTMLElement, width: number): void {
  const clamped = Math.min(MENU_WIDTH.max, Math.max(MENU_WIDTH.min, width))
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

function setMenuCollapsed(menu: HTMLElement, collapsed: boolean): boolean {
  menu.classList.toggle("collapse", collapsed)
  if (!collapsed) store(COLLAPSED_KEY, null)
  return collapsed
}
