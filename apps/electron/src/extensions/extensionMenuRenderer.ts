import { ExtensionMenuBridge, ExtensionMenuState } from "./extensionMenuTypes"
import "./extensionMenu.css"

declare global {
  interface Window { onceExtensionMenu: ExtensionMenuBridge }
}

const bridge = window.onceExtensionMenu
function required(id: string): HTMLElement {
  const element = document.getElementById(id)
  if (!element) throw new Error(`Missing extensions panel element: ${id}`)
  return element
}
const list = required("extensions")
const errorLabel = required("error")
const pinIcon = '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="M9 3h6l-1 7 3 3v2H7v-2l3-3-1-7ZM12 15v6"/></svg>'

async function act(action: "pin" | "open" | "settings" | "close", host?: string): Promise<void> {
  try {
    const state = await bridge.action(action, host)
    if (action === "pin") {
      render(state)
      Array.from(list.querySelectorAll<HTMLButtonElement>(".pin")).find(button => button.dataset.host === host)?.focus()
    }
  } catch (error) {
    errorLabel.hidden = false
    errorLabel.textContent = error instanceof Error ? error.message : String(error)
  }
}

function render(state: ExtensionMenuState): void {
  const pinned = new Set(state.pinned)
  list.replaceChildren()
  for (const info of state.infos) {
    const row = document.createElement("div")
    row.className = "extension-row"
    const open = document.createElement("button")
    open.type = "button"
    open.className = "extension-open"
    open.disabled = !info.enabled
    open.title = info.title
    open.setAttribute("aria-label", `Open ${info.name}`)
    const icon = document.createElement("span")
    icon.className = "extension-icon"
    if (info.icon) {
      const image = document.createElement("img")
      image.src = info.icon
      image.alt = ""
      icon.append(image)
    } else icon.textContent = info.name.slice(0, 1).toUpperCase()
    if (info.badgeText) {
      const badge = document.createElement("span")
      badge.className = "badge"
      badge.textContent = info.badgeText
      icon.append(badge)
    }
    const name = document.createElement("span")
    name.className = "extension-name"
    name.textContent = info.name
    open.append(icon, name)
    open.onclick = () => void act("open", info.host)
    const pin = document.createElement("button")
    pin.type = "button"
    pin.className = "icon-button pin"
    pin.dataset.host = info.host
    pin.innerHTML = pinIcon
    pin.setAttribute("aria-pressed", String(pinned.has(info.host)))
    pin.setAttribute("aria-label", `${pinned.has(info.host) ? "Unpin" : "Pin"} ${info.name}`)
    pin.title = pinned.has(info.host) ? "Unpin from toolbar" : "Pin to toolbar"
    pin.onclick = () => void act("pin", info.host)
    row.append(open, pin)
    list.append(row)
  }
  if (!state.infos.length) {
    const empty = document.createElement("p")
    empty.className = "empty"
    empty.textContent = "No extensions installed. Add extensions in settings."
    list.append(empty)
  }
}

required("close").onclick = () => void act("close")
required("settings").onclick = () => void act("settings")
document.addEventListener("keydown", event => {
  if (event.key === "Escape") { event.preventDefault(); void act("close"); return }
  const buttons = Array.from(document.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"))
  const current = buttons.indexOf(document.activeElement as HTMLButtonElement)
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault()
    buttons[(current + (event.key === "ArrowDown" ? 1 : buttons.length - 1)) % buttons.length]?.focus()
  }
  if (event.key === "Tab" && ((event.shiftKey && current === 0) || (!event.shiftKey && current === buttons.length - 1))) {
    event.preventDefault()
    buttons[event.shiftKey ? buttons.length - 1 : 0]?.focus()
  }
})
void bridge.state().then(state => {
  render(state)
  document.querySelector<HTMLButtonElement>(".extension-open:not(:disabled), #settings")?.focus()
}).catch(error => { errorLabel.hidden = false; errorLabel.textContent = String(error) })
