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

interface Row {
  id: string
  name: string
  title: string
  enabled: boolean
  icon: HTMLElement
}

function row(entry: Row, pinned: Set<string>): HTMLElement {
  const row = document.createElement("div")
  row.className = "extension-row"
  const open = document.createElement("button")
  open.type = "button"
  open.className = "extension-open"
  open.disabled = !entry.enabled
  open.title = entry.title
  open.setAttribute("aria-label", `Open ${entry.name}`)
  const name = document.createElement("span")
  name.className = "extension-name"
  name.textContent = entry.name
  open.append(entry.icon, name)
  open.onclick = () => void act("open", entry.id)
  const pin = document.createElement("button")
  pin.type = "button"
  pin.className = "icon-button pin"
  pin.dataset.host = entry.id
  pin.innerHTML = pinIcon
  pin.setAttribute("aria-pressed", String(pinned.has(entry.id)))
  pin.setAttribute("aria-label", `${pinned.has(entry.id) ? "Unpin" : "Pin"} ${entry.name}`)
  pin.title = pinned.has(entry.id) ? "Unpin from toolbar" : "Pin to toolbar"
  pin.onclick = () => void act("pin", entry.id)
  row.append(open, pin)
  return row
}

function iconBox(name: string, image: string | null, masked: boolean): HTMLElement {
  const icon = document.createElement("span")
  icon.className = "extension-icon"
  if (image && masked) {
    // A shell icon is a monochrome SVG; paint it in the panel's text colour.
    const glyph = document.createElement("span")
    glyph.className = "tool-glyph"
    glyph.style.setProperty("--glyph", `url("${image}")`)
    icon.append(glyph)
  } else if (image) {
    const img = document.createElement("img")
    img.src = image
    img.alt = ""
    icon.append(img)
  } else icon.textContent = name.slice(0, 1).toUpperCase()
  return icon
}

function render(state: ExtensionMenuState): void {
  const pinned = new Set(state.pinned)
  list.replaceChildren()
  for (const tool of state.tools) {
    list.append(row({ id: tool.id, name: tool.name, title: tool.name, enabled: tool.enabled, icon: iconBox(tool.name, tool.icon, true) }, pinned))
  }
  if (state.tools.length) {
    const divider = document.createElement("hr")
    divider.className = "divider"
    list.append(divider)
  }
  for (const info of state.infos) {
    const icon = iconBox(info.name, info.icon, false)
    if (info.badgeText) {
      const badge = document.createElement("span")
      badge.className = "badge"
      badge.textContent = info.badgeText
      icon.append(badge)
    }
    list.append(row({ id: info.host, name: info.name, title: info.title, enabled: info.enabled, icon }, pinned))
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
