export function input(type: string, value = ""): HTMLInputElement {
  const element = document.createElement("input"); element.type = type; element.value = value
  return element
}
export function select(options: [string, string][], value = ""): HTMLSelectElement {
  const element = document.createElement("select")
  for (const [id, label] of options) { const option = document.createElement("option"); option.value = id; option.textContent = label; element.append(option) }
  if (value && !options.some(([id]) => id === value)) { const option = document.createElement("option"); option.value = value; option.textContent = `${value} (unavailable)`; element.append(option) }
  element.value = value
  return element
}
export function field(parent: HTMLElement, label: string, control: HTMLElement): void {
  const row = document.createElement("div"); row.className = "settings_row"
  const title = document.createElement("label"); title.className = "settings_row_name"; title.textContent = label
  control.id ||= `ai-${crypto.randomUUID()}`; title.htmlFor = control.id
  row.append(title, control); parent.append(row)
}
export function button(label: string, action: () => void): HTMLButtonElement {
  const element = document.createElement("button"); element.type = "button"; element.className = "button"; element.textContent = label; element.onclick = action; element.dataset.aiFocusKey = label
  return element
}
export function actions(parent: HTMLElement, ...controls: HTMLElement[]): void {
  const row = document.createElement("div"); row.className = "settings_actions cluster"; row.append(...controls); parent.append(row)
}
export function heading(parent: HTMLElement, text: string): void {
  const title = document.createElement("h4"); title.className = "settings_subheading"; title.textContent = text; parent.append(title)
}
/** A heading and the rows it names, boxed so that neighbouring runs read as separate groups. Returns the box. */
export function card(parent: HTMLElement, title?: string): HTMLElement {
  const group = document.createElement("section"); group.className = "ai_group"
  if (title) heading(group, title)
  const body = document.createElement("div"); body.className = "ai_card"; group.append(body); parent.append(group)
  return body
}
/** A state in words as well as colour: "ok" and "warn" are filled, "plain" is an outlined fact. */
export function badge(text: string, tone: "ok" | "warn" | "plain" = "plain"): HTMLElement {
  const element = document.createElement("span"); element.className = "ai_badge"; element.dataset.tone = tone; element.textContent = text
  return element
}
export const providerLabels: Record<string, string> = { openai: "OpenAI", anthropic: "Anthropic", compatible: "Compatible server", searxng: "SearXNG", tavily: "Tavily" }
export function providerIcon(provider: string, name: string): HTMLElement {
  const icon = document.createElement("span"); icon.className = "ai_provider_icon"; icon.dataset.provider = provider; icon.setAttribute("aria-hidden", "true")
  icon.textContent = (name.trim()[0] ?? "?").toUpperCase()
  return icon
}
/** The last row of a card that adds to it. The plus is an element, not generated content, so the accessible name stays the label. */
export function addRow(label: string, action: () => void): HTMLButtonElement {
  const row = button("", action); row.className = "ai_add_row"; row.dataset.aiFocusKey = label
  const plus = document.createElementNS("http://www.w3.org/2000/svg", "svg"); plus.setAttribute("viewBox", "0 0 16 16"); plus.setAttribute("aria-hidden", "true")
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path"); path.setAttribute("d", "M8 3v10M3 8h10"); plus.append(path)
  row.append(plus, label)
  return row
}
interface LinkRowExtras { badge?: HTMLElement; icon?: HTMLElement; label?: string; key?: string }
export function linkRow(title: string, detail: string, action: () => void, extras: LinkRowExtras = {}): HTMLButtonElement {
  const row = button("", action); row.className = "settings_link_row"; row.dataset.aiFocusKey = extras.key ?? title
  row.setAttribute("aria-label", extras.label ?? `${title}: ${detail}${extras.badge ? ` · ${extras.badge.textContent}` : ""}`)
  const name = document.createElement("strong"); name.textContent = title
  const description = document.createElement("span"); description.className = "settings_link_summary"; description.textContent = detail
  const arrow = document.createElement("span"); arrow.className = "settings_link_arrow"; arrow.textContent = "›"; arrow.setAttribute("aria-hidden", "true")
  if (extras.icon) { row.classList.add("settings_link_row_icon"); row.append(extras.icon) }
  row.append(name, description)
  if (extras.badge) row.append(extras.badge)
  row.append(arrow)
  return row
}
export function feedback(parent: HTMLElement): HTMLElement {
  const status = document.createElement("p"); status.className = "settings_rows_hint"; status.setAttribute("role", "status"); parent.append(status); return status
}

export function pageTitle(root: HTMLElement, title: string): void {
  const heading = root.closest("#settings_panel")?.querySelector(".settings_title")
  if (heading && root.closest(".settings_section")?.classList.contains("active")) heading.textContent = title
}

/** Keep the focus destination until asynchronous summary rendering completes. */
export function editorReturn(root: HTMLElement, done: () => void, key: string): () => void {
  return () => { root.dataset.aiFocusReturn = key; done() }
}
export function retainAiFocus(root: HTMLElement): void {
  const active = document.activeElement
  if (active instanceof HTMLElement && root.contains(active) && active.dataset.aiFocusKey) root.dataset.aiFocusReturn = active.dataset.aiFocusKey
}
export function restoreAiFocus(root: HTMLElement): void {
  const key = root.dataset.aiFocusReturn
  const target = [...root.querySelectorAll<HTMLElement>("[data-ai-focus-key]")].find(item => item.dataset.aiFocusKey === key && !item.closest("[hidden]"))
  if (target) { target.focus({ preventScroll: true }); delete root.dataset.aiFocusReturn }
}
