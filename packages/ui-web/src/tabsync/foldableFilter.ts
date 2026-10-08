/**
 * The filter behind a search button, for a phone: the summary line keeps its
 * room until the reader asks to filter. Opening swaps that line for the
 * field; its × (or Escape) clears the filter and brings the line back.
 */
export function foldableFilter(head: HTMLElement, search: HTMLElement, filter: HTMLInputElement, rerender: () => void): void {
  let open = false
  const toggle = iconButton("search", "Filter tabs", "remote_tabs_search_toggle", "remote-tabs-search")
  const close = iconButton("x", "Close filter", "remote_tabs_search_close", "remote-tabs-search-close")
  toggle.setAttribute("aria-controls", filter.id)
  const sync = () => {
    search.hidden = !open
    head.classList.toggle("remote_tabs_head--searching", open)
    toggle.setAttribute("aria-expanded", String(open))
  }
  const shut = () => {
    open = false
    filter.value = ""
    sync()
    rerender()
    toggle.focus()
  }
  toggle.addEventListener("click", () => {
    open = true
    sync()
    filter.focus()
  })
  close.addEventListener("click", shut)
  filter.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return
    // Handled here: the tab view around the list closes on an Escape nobody took.
    event.preventDefault()
    shut()
  })
  head.insertBefore(toggle, head.querySelector(".remote_tabs_settings"))
  search.append(close)
  sync()
}

function iconButton(icon: string, label: string, className: string, testid: string): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = `button button--icon ${className}`
  button.title = label
  button.setAttribute("aria-label", label)
  button.dataset.testid = testid
  const glyph = document.createElement("span")
  glyph.className = `icon icon--chrome icon--${icon}`
  glyph.setAttribute("aria-hidden", "true")
  button.append(glyph)
  return button
}
