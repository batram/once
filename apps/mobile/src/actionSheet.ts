/**
 * Long-press action sheet for story rows.
 *
 * The shared UI renders per-story action buttons (.button_group .btn) which
 * are hidden on mobile; a long-press on a story opens a bottom sheet whose
 * rows proxy those hidden buttons, so all persistence/reader logic stays in
 * @once/ui-web.
 */

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE_PX = 10

let sheetHost: HTMLDivElement | null = null

function ensureSheetHost(): HTMLDivElement {
  if (sheetHost) return sheetHost
  sheetHost = document.createElement("div")
  sheetHost.className = "once-sheet"
  sheetHost.hidden = true

  const backdrop = document.createElement("div")
  backdrop.className = "once-sheet-backdrop"
  backdrop.addEventListener("click", closeSheet)
  sheetHost.appendChild(backdrop)

  const panel = document.createElement("div")
  panel.className = "once-sheet-panel"
  panel.setAttribute("role", "menu")
  sheetHost.appendChild(panel)

  document.body.appendChild(sheetHost)
  return sheetHost
}

function closeSheet(): void {
  if (!sheetHost) return
  sheetHost.hidden = true
  document.body.classList.remove("once-sheet-open")
}

// Buttons in the shared UI are wired to different events (read/star use
// click, the reader button fires on mouseup), so replay the full sequence.
function triggerButton(btn: HTMLElement): void {
  for (const type of ["mousedown", "mouseup", "click"]) {
    btn.dispatchEvent(
      new MouseEvent(type, { button: 0, bubbles: true, cancelable: true })
    )
  }
}

function isSheetOpen(): boolean {
  return sheetHost !== null && !sheetHost.hidden
}

function openSheet(story: HTMLElement): void {
  if (isSheetOpen()) return
  const host = ensureSheetHost()
  const panel = host.querySelector<HTMLDivElement>(".once-sheet-panel")
  if (!panel) return
  panel.textContent = ""

  const title = document.createElement("div")
  title.className = "once-sheet-title"
  title.textContent =
    story.dataset.title ?? story.querySelector(".title")?.textContent ?? ""
  panel.appendChild(title)

  const buttons = story.querySelectorAll<HTMLElement>(".button_group .btn")
  const labelOverrides: Record<string, string> = {
    outline: "Open reader",
    filter: "Filter source",
    filtered: "Edit filter"
  }
  for (const btn of buttons) {
    const label =
      labelOverrides[btn.title] ?? (btn.title || btn.classList[1] || "action")
    const row = document.createElement("button")
    row.type = "button"
    row.className = "once-sheet-action"
    row.textContent = label.charAt(0).toUpperCase() + label.slice(1)
    const testid = btn.dataset.testid ?? btn.classList[1]
    if (testid) row.dataset.testid = `sheet-${testid}`
    row.addEventListener("click", () => {
      closeSheet()
      triggerButton(btn)
    })
    panel.appendChild(row)
  }

  const cancel = document.createElement("button")
  cancel.type = "button"
  cancel.className = "once-sheet-action once-sheet-cancel"
  cancel.dataset.testid = "sheet-cancel"
  cancel.textContent = "Cancel"
  cancel.addEventListener("click", closeSheet)
  panel.appendChild(cancel)

  host.hidden = false
  document.body.classList.add("once-sheet-open")
}

export function installStoryActionSheet(): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let startX = 0
  let startY = 0
  let pointerId: number | undefined

  const cancelPress = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    pointerId = undefined
    document.removeEventListener("pointermove", onMove)
    document.removeEventListener("pointerup", cancelPress)
    document.removeEventListener("pointercancel", cancelPress)
  }

  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return
    if (
      Math.abs(event.clientX - startX) > MOVE_TOLERANCE_PX ||
      Math.abs(event.clientY - startY) > MOVE_TOLERANCE_PX
    ) {
      cancelPress()
    }
  }

  // Swallows the click/mouse events the browser synthesizes when the finger
  // lifts after a long-press, so the title link underneath doesn't navigate
  // and sheet rows under the finger don't get phantom-tapped. Armed when the
  // sheet opens, disarmed shortly after the pointer lifts — never left armed
  // (a stale once-listener would eat the user's next real tap).
  const suppressEvent = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    // The synthesized click is the last event of the release sequence;
    // disarm right away so the user's next real tap goes through.
    if (event.type === "click") disarmSuppressor()
  }
  const disarmSuppressor = () => {
    document.removeEventListener("click", suppressEvent, true)
    document.removeEventListener("mousedown", suppressEvent, true)
    document.removeEventListener("mouseup", suppressEvent, true)
  }
  const armSuppressor = () => {
    document.addEventListener("click", suppressEvent, true)
    document.addEventListener("mousedown", suppressEvent, true)
    document.addEventListener("mouseup", suppressEvent, true)
    // Fallback for platforms that don't synthesize a click after long-press.
    document.addEventListener(
      "pointerup",
      () => setTimeout(disarmSuppressor, 250),
      { capture: true, once: true }
    )
  }

  document.addEventListener("pointerdown", (event) => {
    if (isSheetOpen()) return
    const story = (event.target as Element | null)?.closest<HTMLElement>(
      "story-item"
    )
    if (!story || !event.isPrimary) return
    cancelPress()
    pointerId = event.pointerId
    startX = event.clientX
    startY = event.clientY
    document.addEventListener("pointermove", onMove)
    document.addEventListener("pointerup", cancelPress)
    document.addEventListener("pointercancel", cancelPress)
    timer = setTimeout(() => {
      cancelPress()
      armSuppressor()
      openSheet(story)
    }, LONG_PRESS_MS)
  })

  // Android fires contextmenu on long-press; the sheet replaces it.
  document.addEventListener("contextmenu", (event) => {
    if ((event.target as Element | null)?.closest("story-item")) {
      event.preventDefault()
    }
  })
}
