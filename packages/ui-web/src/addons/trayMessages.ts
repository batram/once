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
    elements.push(message.title ? disclosure(disclosed, index, message.title, message.collapsed === true, block) : block)
    // Sources follow the message under their own fold, in view even when the
    // message itself is folded. Its state is kept apart from the message's.
    if (message.sources?.length) elements.push(sourceFold(disclosed, -(index + 1), message.sources))
  }
  return elements
}

/**
 * A "Sources" fold like the titled messages'. Closed, the heading carries the
 * citation chips — `S1 S2 …`, as the answer names them — each a link; open,
 * the body lists every source with its title and address. A source titled
 * without a leading `[S1]` is numbered by its position.
 */
function sourceFold(disclosed: TrayDisclosures, key: number, sources: readonly { title: string; url: string }[]): HTMLElement {
  const chips = document.createElement("span")
  chips.className = "addon_tray_sources_chips"
  chips.append(...sources.map((source, index) => sourceLink(source, index, false)))
  const list = document.createElement("ul")
  list.className = "addon_tray_sources_list"
  for (const [index, source] of sources.entries()) {
    const item = document.createElement("li")
    item.append(sourceLink(source, index, true))
    list.append(item)
  }
  const details = disclosure(disclosed, key, "Sources", true, list)
  details.classList.add("addon_tray_sources")
  details.querySelector("summary")?.append(chips)
  return details
}

function sourceLink(source: { title: string; url: string }, index: number, detailed: boolean): HTMLAnchorElement {
  const match = /^\[([^\]\s]{1,8})\]\s*/.exec(source.title)
  const label = match ? match[1] : String(index + 1)
  const title = (match ? source.title.slice(match[0].length) : source.title) || source.url
  const link = document.createElement("a")
  link.href = source.url
  link.target = "_blank"
  link.rel = "noopener noreferrer"
  link.className = "addon_tray_source"
  link.title = title
  const chip = document.createElement("span")
  chip.className = "addon_tray_source_label"
  chip.textContent = label
  link.append(chip)
  if (!detailed) return link
  const detail = document.createElement("span")
  detail.className = "addon_tray_source_detail"
  const name = document.createElement("span")
  name.className = "addon_tray_source_title"
  name.textContent = title
  const address = document.createElement("span")
  address.className = "addon_tray_source_url"
  address.textContent = source.url
  detail.append(name, address)
  link.append(detail)
  return link
}

/** A titled message folds behind a native disclosure. The attribute, not the
 *  property, carries the state so the same code reads under linkedom. */
function disclosure(disclosed: TrayDisclosures, key: number, title: string, collapsed: boolean, block: HTMLElement): HTMLElement {
  const details = document.createElement("details")
  details.className = "addon_tray_disclosure"
  details.toggleAttribute("open", disclosed.get(key) ?? !collapsed)
  details.addEventListener("toggle", () => disclosed.set(key, details.hasAttribute("open")))
  const summary = document.createElement("summary")
  summary.className = "addon_tray_disclosure_title"
  const heading = document.createElement("span")
  heading.textContent = title
  summary.append(heading)
  const body = document.createElement("div")
  body.className = "addon_tray_disclosure_body"
  body.append(block)
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
