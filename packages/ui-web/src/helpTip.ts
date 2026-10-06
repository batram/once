/**
 * A setting's longer explanation behind a small (?) button beside its name.
 * A pointer shows it on hover; a click or tap keeps it open until the next
 * click, Escape or a tap elsewhere. The explanation stays the element it was,
 * only hidden, so `aria-describedby` on the control and the settings search
 * still read it.
 */

const EDGE_GAP_PX = 8
const ANCHOR_GAP_PX = 6

interface OpenTip { button: HTMLButtonElement; text: HTMLElement; pinned: boolean }
let open: OpenTip | null = null
let installed = false

/**
 * Puts `text` behind a (?) button beside `name`. A label keeps its own
 * accessible name: the button goes next to it rather than inside it.
 */
export function attachHelpTip(name: HTMLElement, text: HTMLElement): HTMLButtonElement {
  installDocumentListeners()
  if (!text.id) text.id = `help_tip_${Math.random().toString(36).slice(2, 10)}`
  const button = document.createElement("button")
  button.type = "button"
  button.className = "button button--icon help_tip"
  const subject = name.textContent?.replace(/\s+/g, " ").trim() || "this setting"
  button.setAttribute("aria-label", `About ${subject}`)
  button.setAttribute("aria-expanded", "false")
  button.setAttribute("aria-controls", text.id)
  button.dataset.testid = "help-tip"
  const icon = document.createElement("span")
  icon.className = "icon icon--help"
  icon.setAttribute("aria-hidden", "true")
  button.append(icon)
  // Its own voice now, not the hint or description it was written as.
  text.classList.remove("settings_row_hint", "settings_group_hint", "settings_rows_hint", "settings_description", "field_hint")
  text.classList.add("help_tip_text")
  text.hidden = true
  if (name.tagName === "LABEL" || name.matches(".settings_row_name")) {
    // The row's name column becomes the label, the button and the text.
    const heading = document.createElement("div")
    heading.className = `${name.className} help_tip_name`
    name.classList.remove("settings_row_name")
    name.replaceWith(heading)
    heading.append(name, button, text)
  } else {
    name.append(" ", button)
  }
  button.addEventListener("click", () => {
    if (open?.button === button && open.pinned) close()
    else show(button, text, true)
  })
  button.addEventListener("pointerenter", (event) => {
    if (event.pointerType === "mouse" && !open?.pinned) show(button, text, false)
  })
  button.addEventListener("pointerleave", (event) => {
    if (event.pointerType === "mouse" && open?.button === button && !open.pinned) close()
  })
  return button
}

/**
 * Upgrades every explanation marked `data-help` under `root`. A row's hint
 * goes beside the row's name; any other beside the heading or one-line
 * description before it.
 */
export function bindHelpTips(root: ParentNode = document): void {
  for (const text of root.querySelectorAll<HTMLElement>("[data-help]:not(.help_tip_text)")) {
    const row = text.closest(".settings_row")
    const name = row?.querySelector<HTMLElement>(".settings_row_name") ?? previousHeading(text)
    if (name) attachHelpTip(name, text)
  }
}

function previousHeading(element: HTMLElement): HTMLElement | null {
  const previous = element.previousElementSibling
  // A heading, or the one-line description a longer explanation follows.
  return previous && (/^H[1-6]$/.test(previous.tagName) || previous.matches(".settings_description"))
    ? previous as HTMLElement : null
}

function show(button: HTMLButtonElement, text: HTMLElement, pinned: boolean): void {
  if (open && open.button !== button) close()
  open = { button, text, pinned }
  text.hidden = false
  button.setAttribute("aria-expanded", "true")
  place(button, text)
}

function close(): void {
  if (!open) return
  open.text.hidden = true
  open.button.setAttribute("aria-expanded", "false")
  open = null
}

/** Under the button, or above it when the viewport ends first; never past an edge. */
function place(button: HTMLElement, text: HTMLElement): void {
  text.style.left = "0px"
  text.style.top = "0px"
  const anchor = button.getBoundingClientRect()
  const box = text.getBoundingClientRect()
  const left = Math.max(EDGE_GAP_PX, Math.min(anchor.left, window.innerWidth - box.width - EDGE_GAP_PX))
  const below = anchor.bottom + ANCHOR_GAP_PX
  const top = below + box.height > window.innerHeight - EDGE_GAP_PX
    ? Math.max(EDGE_GAP_PX, anchor.top - ANCHOR_GAP_PX - box.height)
    : below
  text.style.left = `${Math.round(left)}px`
  text.style.top = `${Math.round(top)}px`
}

function installDocumentListeners(): void {
  if (installed) return
  installed = true
  document.addEventListener("pointerdown", (event) => {
    if (!open || !(event.target instanceof Node)) return
    if (open.button.contains(event.target) || open.text.contains(event.target)) return
    close()
  }, true)
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || !open) return
    const button = open.button
    close()
    button.focus()
    event.stopPropagation()
  }, true)
  // The text is placed against the viewport, so it goes when what it points at moves.
  document.addEventListener("scroll", (event) => {
    if (open && !(event.target instanceof Node && open.text.contains(event.target))) close()
  }, true)
  document.defaultView?.addEventListener("resize", close)
  document.addEventListener("once-panel-changed", close)
}

/**
 * A one-line description with the rest of its explanation behind a help tip,
 * for pages built in code: `[description, explanation]`, to append in order.
 */
export function explained(short: string, more: string, className = "settings_description"): [HTMLElement, HTMLElement] {
  const description = document.createElement("p")
  description.className = className
  description.textContent = short
  const explanation = document.createElement("p")
  explanation.textContent = more
  attachHelpTip(description, explanation)
  return [description, explanation]
}
