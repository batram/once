import { requireElement } from "../dom"

// The shell shows one of three panels — stories, reading, settings — inside
// `#left_panel`. The active one is named by the `active_panel` attribute, and
// `once-panel-changed` is how the rest of the app hears about a switch.
function panelFor(button: HTMLElement): string {
  const panel = button.dataset.panel
  if (panel) return panel
  throw new Error("Menu button is missing data-panel")
}

export function open_panel(panel: string): void {
  const left_panel = requireElement<HTMLElement>("#left_panel")
  left_panel.setAttribute("active_panel", panel)
  document.dispatchEvent(new CustomEvent("once-panel-changed", {
    detail: { panel }
  }))
}

function highlight_panel(panel: string) {
  const target_panel = requireElement<HTMLElement>(
    "#" + panel + "_panel"
  )
  target_panel.classList.add("pseudo_active")
}
function delight_panel(panel: string) {
  const target_panel = requireElement<HTMLElement>(
    "#" + panel + "_panel"
  )
  target_panel.classList.remove("pseudo_active")
}

// Press feedback for anything that opens a panel, including the sidebar filter
// buttons, which is why this is exported rather than private.
export function active_flash_panel(btn: HTMLElement): void {
  btn.onmousedown = () => {
    highlight_panel(panelFor(btn))
  }
  btn.onmouseup = () => {
    delight_panel(panelFor(btn))
  }
  btn.onmouseout = () => {
    delight_panel(panelFor(btn))
  }
}

export function init(): void {
  document.querySelectorAll<HTMLElement>("#menu .sub").forEach((sub_menu) => {
    sub_menu.onclick = (event) => {
      const panel = panelFor(sub_menu)
      const clickedStatus = event.target instanceof Element &&
        event.target.closest("#status_dock")
      if (panel === "settings" && !clickedStatus) {
        document.dispatchEvent(new CustomEvent("once-settings-index-requested"))
      }
      open_panel(panel)
    }
    sub_menu.querySelectorAll("img").forEach((x) => {
      x.setAttribute("draggable", "false")
    })
    active_flash_panel(sub_menu)
  })

  open_panel("stories")
}
