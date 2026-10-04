import { requireElement } from "../dom"

// The shell shows one of its panels — stories, reading, settings, and the
// temporary ones that come and go — inside
// `#left_panel`. The active one is named by the `active_panel` attribute, and
// `once-panel-changed` is how the rest of the app hears about a switch.
function panelFor(button: HTMLElement): string {
  const panel = button.dataset.panel
  if (panel) return panel
  throw new Error("Menu button is missing data-panel")
}

// The panels shown before the active one, most recent last. Some panels exist
// only for a while (an add-on conversation, a story's comments), so closing
// one returns to the latest that still exists, never to one already gone.
const visited: string[] = []

const panelExists = (panel: string): boolean => document.getElementById(`${panel}_panel`) !== null

function forget(panel: string): void {
  for (let index = visited.indexOf(panel); index >= 0; index = visited.indexOf(panel)) visited.splice(index, 1)
}

/** The panel shown most recently that still exists, other than `excluding`; the stories at the bottom. */
function lastOpenPanel(excluding: string): string {
  for (let index = visited.length - 1; index >= 0; index--) {
    const panel = visited[index]
    if (panel !== excluding && panelExists(panel)) return panel
  }
  return "stories"
}

/** Shows a panel; one that does not exist (any more) gives way to the last open one. */
export function open_panel(panel: string): void {
  const left_panel = requireElement<HTMLElement>("#left_panel")
  const previous = left_panel.getAttribute("active_panel")
  const target = panelExists(panel) ? panel : lastOpenPanel(panel)
  if (previous && previous !== target && panelExists(previous)) {
    forget(previous)
    visited.push(previous)
  }
  forget(target)
  left_panel.setAttribute("active_panel", target)
  document.dispatchEvent(new CustomEvent("once-panel-changed", {
    detail: { panel: target, previous }
  }))
}

/**
 * A panel was taken away: it is forgotten, and when it was the one showing,
 * the reader returns to the panel they had open before it.
 */
export function closePanel(panel: string): void {
  forget(panel)
  if (document.querySelector("#left_panel")?.getAttribute("active_panel") === panel) open_panel(lastOpenPanel(panel))
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
  document.querySelectorAll<HTMLButtonElement>(
    "#menu > button.sidebar_panel, #menu > .sidebar_panel > button.heading"
  ).forEach((sub_menu) => {
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
