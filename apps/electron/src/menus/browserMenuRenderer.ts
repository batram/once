import { BrowserMenuAction, BrowserMenuBridge, BrowserMenuState } from "./browserMenuTypes"
import "./browserMenu.css"

declare global {
  interface Window { onceBrowserMenu: BrowserMenuBridge }
}

const bridge = window.onceBrowserMenu
function required<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing browser menu element: ${id}`)
  return element as T
}
const errorLabel = required("error")
const zoomValue = required<HTMLButtonElement>("zoom-value")

function render(state: BrowserMenuState): void {
  for (const kbd of document.querySelectorAll<HTMLElement>("kbd[data-shortcut]")) {
    kbd.textContent = state.shortcuts[kbd.dataset.shortcut as keyof BrowserMenuState["shortcuts"]] ?? ""
  }
  const noTab = state.zoom === null
  for (const action of ["zoom-in", "zoom-out", "zoom-reset", "close-tab"]) {
    const button = document.querySelector<HTMLButtonElement>(`[data-action="${action}"]`)
    if (button) button.disabled = noTab
  }
  zoomValue.textContent = `${Math.round((state.zoom ?? 1) * 100)}%`
  const fullscreen = required<HTMLButtonElement>("fullscreen")
  fullscreen.setAttribute("aria-pressed", String(state.fullscreen))
  const label = state.fullscreen ? "Exit full screen" : "Full screen"
  fullscreen.setAttribute("aria-label", label)
  fullscreen.title = state.shortcuts.fullscreen ? `${label} (${state.shortcuts.fullscreen})` : label
  required("clear-site").hidden = !state.site
  required("site-divider").hidden = !state.site
  required("clear-site-label").textContent = state.site ? `Clear data for ${state.site}…` : ""
}

async function act(action: BrowserMenuAction): Promise<void> {
  try {
    render(await bridge.action(action))
  } catch (error) {
    errorLabel.hidden = false
    errorLabel.textContent = error instanceof Error ? error.message : String(error)
  }
}

for (const button of document.querySelectorAll<HTMLButtonElement>("button[data-action]")) {
  button.onclick = () => void act(button.dataset.action as BrowserMenuAction)
}
bridge.onStateChanged(render)
// The menu holds the keyboard while open, so the zoom keys act on the tab from here.
const ZOOM_KEYS: Record<string, BrowserMenuAction> = { "+": "zoom-in", "=": "zoom-in", "-": "zoom-out", "0": "zoom-reset" }
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") { event.preventDefault(); void act("close"); return }
  const zoom = (event.ctrlKey || event.metaKey) && !event.altKey ? ZOOM_KEYS[event.key] : undefined
  if (zoom) { event.preventDefault(); void act(zoom); return }
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"))
    .filter((button) => button.offsetParent !== null)
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  const step = event.key === "ArrowDown" || event.key === "ArrowRight" ? 1
    : event.key === "ArrowUp" || event.key === "ArrowLeft" ? -1 : 0
  if (step) {
    event.preventDefault()
    buttons[(current + step + buttons.length) % buttons.length]?.focus()
  }
})
void bridge.state().then(async (state) => {
  render(state)
  document.querySelector<HTMLButtonElement>("[role=menuitem]")?.focus()
  await bridge.ready(Math.ceil(document.body.getBoundingClientRect().height))
}).catch((error) => { errorLabel.hidden = false; errorLabel.textContent = String(error) })
