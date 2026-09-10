import { AddonTrayView } from "@once/core"
import { trayMarkdown } from "./trayMarkdown"

/** Where the reader left each titled message, by index; a redraw must not fold what they opened. */
export type TrayDisclosures = Map<number, boolean>

/**
 * The messages of a tray view as elements, the same in a story row and on a
 * conversation page: assistant text as sanitized markdown, the reader's own
 * turns as text, sources as links, and titled messages behind disclosures.
 */
export function renderTrayMessages(view: AddonTrayView, disclosed: TrayDisclosures): HTMLElement[] {
  const elements: HTMLElement[] = []
  for (const [index, message] of view.messages.entries()) {
    const block = document.createElement("div")
    block.className = `addon_tray_message addon_tray_${message.role}`
    if (message.role === "assistant") block.append(trayMarkdown(message.text))
    else block.textContent = message.text
    const sources = (message.sources ?? []).map(source => sourceLink(source))
    if (message.title) elements.push(disclosure(disclosed, index, message.title, message.collapsed === true, block, sources))
    else elements.push(block, ...sources)
  }
  return elements
}

function sourceLink(source: { title: string; url: string }): HTMLAnchorElement {
  const link = document.createElement("a")
  link.textContent = source.title || source.url
  link.href = source.url
  link.target = "_blank"
  link.rel = "noopener noreferrer"
  link.className = "addon_tray_source"
  link.prepend(trayIcon("popout", "icon--inline"))
  return link
}

/** A titled message folds behind a native disclosure. The attribute, not the
 *  property, carries the state so the same code reads under linkedom. */
function disclosure(disclosed: TrayDisclosures, index: number, title: string, collapsed: boolean, block: HTMLElement, sources: HTMLElement[]): HTMLElement {
  const details = document.createElement("details")
  details.className = "addon_tray_disclosure"
  details.toggleAttribute("open", disclosed.get(index) ?? !collapsed)
  details.addEventListener("toggle", () => disclosed.set(index, details.hasAttribute("open")))
  const summary = document.createElement("summary")
  summary.className = "addon_tray_disclosure_title"
  summary.textContent = title
  const body = document.createElement("div")
  body.className = "addon_tray_disclosure_body"
  body.append(block, ...sources)
  details.append(summary, body)
  return details
}

/** The status line under the messages: what the answer was built from, or why there is none. */
export function renderTrayStatus(view: AddonTrayView, busy: boolean, error: string): HTMLElement {
  const status = document.createElement("p")
  status.setAttribute("role", "status")
  // A host failure and an addon reporting its own through statusTone read the
  // same to the reader, so they get the same treatment.
  const failed = !busy && (error !== "" || view.statusTone === "error")
  status.className = failed ? "addon_tray_status addon_tray_status--error" : "addon_tray_status"
  status.textContent = busy ? "Working…" : error || view.status || ""
  return status
}

/** `.icon` has no default size, so every call site names one: `.icon--inline`
 *  for a glyph in running text, or a component rule for the rest. */
export function trayIcon(name: string, sized = ""): HTMLElement {
  const glyph = document.createElement("span")
  glyph.className = sized ? `icon ${sized} icon--${name}` : `icon icon--${name}`
  glyph.setAttribute("aria-hidden", "true")
  return glyph
}

export function trayButton(label: string, run: () => void): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "button"
  button.textContent = label
  button.addEventListener("click", run)
  return button
}
