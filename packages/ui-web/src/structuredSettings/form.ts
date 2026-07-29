export function announceStructuredSettings(message: string): void {
  let status = document.getElementById("structured_settings_status")
  if (!status) {
    status = document.createElement("div")
    status.id = "structured_settings_status"
    status.className = "visually_hidden"
    status.setAttribute("role", "status")
    status.setAttribute("aria-live", "polite")
    document.body.append(status)
  }
  status.textContent = message
}

export function createActionButton(
  label: string,
  action: () => void,
  testid?: string
): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.textContent = label
  if (testid) button.dataset.testid = testid
  button.addEventListener("click", action)
  return button
}

export function createInlineActionButton(
  label: "Save" | "Cancel",
  action: () => void,
  testid?: string
): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "structured_inline_action"
  button.title = label
  button.setAttribute("aria-label", label)
  if (testid) button.dataset.testid = testid
  const glyph = document.createElement("span")
  glyph.className = label === "Save" ? "glyph_check" : "glyph_cross"
  glyph.setAttribute("aria-hidden", "true")
  button.append(glyph)
  button.addEventListener("click", action)
  return button
}

export function createListCard(title: string, count: number): {
  card: HTMLElement
  rows: HTMLElement
} {
  const card = document.createElement("section")
  card.className = "structured_list_card"
  const header = document.createElement("div")
  header.className = "structured_list_header"
  const name = document.createElement("strong")
  name.className = "structured_list_name"
  name.textContent = title
  const total = document.createElement("span")
  total.className = "structured_list_count"
  total.textContent = String(count)
  header.append(name, total)
  const rows = document.createElement("div")
  rows.className = "structured_rows"
  card.append(header, rows)
  return { card, rows }
}
