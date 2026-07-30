export function bindMenuCollapseControls(
  onMenuCollapsedChanged?: (collapsed: boolean) => void
): void {
  const menu = document.querySelector<HTMLElement>("#menu")
  
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
      if (!(target instanceof Element) || !target.closest(".sub")) return
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
    element.textContent = collapsed ? ">" : "<"
  })
  return collapsed
}
