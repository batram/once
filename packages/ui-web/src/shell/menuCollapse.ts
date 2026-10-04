let announceCollapsed: ((collapsed: boolean) => void) | undefined

/** Opens a collapsed sidebar, as a click on its menu would, for a panel that needs to be seen. */
export function expandMenu(): void {
  const menu = document.querySelector<HTMLElement>("#menu")
  if (!menu?.classList.contains("collapse")) return
  setMenuCollapsed(menu, false)
  announceCollapsed?.(false)
}

export function bindMenuCollapseControls(
  onMenuCollapsedChanged?: (collapsed: boolean) => void
): void {
  const menu = document.querySelector<HTMLElement>("#menu")
  announceCollapsed = onMenuCollapsedChanged

  document.querySelectorAll<HTMLElement>(".collapsebutton").forEach((element) => {
    element.onclick = () => {
      const collapsed = toggleMenu(menu)
      onMenuCollapsedChanged?.(collapsed)
    }
  })
  
  if (menu) {
    menu.onclick = (event) => {
      if (!menu.classList.contains("collapse")) return
      const target = event.target
      if (!(target instanceof Element) || !target.closest(".sidebar_panel")) return
      setMenuCollapsed(menu, false)
      onMenuCollapsedChanged?.(false)
    }
  }
}

function toggleMenu(menu: HTMLElement | null): boolean {
  if (!menu) return false
  return setMenuCollapsed(menu, !menu.classList.contains("collapse"))
}

function setMenuCollapsed(menu: HTMLElement, collapsed: boolean): boolean {
  menu.classList.toggle("collapse", collapsed)
  document.querySelectorAll<HTMLElement>(".collapsebutton").forEach((element) => {
    element.classList.toggle("collapsebutton--collapsed", collapsed)
    element.setAttribute(
      "aria-label",
      collapsed ? "Expand sidebar" : "Collapse sidebar"
    )
  })
  return collapsed
}
