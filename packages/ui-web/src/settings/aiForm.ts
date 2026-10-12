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
export function linkRow(title: string, detail: string, action: () => void): HTMLButtonElement {
  const row = button("", action); row.className = "settings_link_row"; row.dataset.aiFocusKey = title; row.setAttribute("aria-label", `${title}: ${detail}`)
  const name = document.createElement("strong"); name.textContent = title
  const description = document.createElement("span"); description.className = "settings_link_summary"; description.textContent = detail
  const arrow = document.createElement("span"); arrow.className = "settings_link_arrow"; arrow.textContent = "›"; arrow.setAttribute("aria-hidden", "true")
  row.append(name, description, arrow)
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
