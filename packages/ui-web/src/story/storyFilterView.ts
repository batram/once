import { Story } from "@once/core"
import { requireElement } from "../dom"
import { showConfirmDialog, showTextInputDialog } from "../confirmDialog"

/** The inline filter editor: one is open at a time, beside its row's filter button. */
let openEditor: { input: HTMLInputElement; close: () => void } | null = null

export function show_filter_dialog(
  event: MouseEvent,
  filter_btn: HTMLElement,
  story: Story,
  callback: (filter: string) => unknown
): void {
  event.stopPropagation()
  event.preventDefault()

  // The button again while its editor is open asks to add what it holds.
  if (openEditor && openEditor.input.nextElementSibling === filter_btn) {
    confirm_add_story(openEditor.input, callback)
    return
  }
  openEditor?.close()

  const inp = document.createElement("input")
  inp.type = "text"
  inp.className = "filter_field filter_editor"
  inp.setAttribute("draggable", "false")
  inp.setAttribute("aria-label", "Filter stories matching")
  inp.value = new URL(story.href).hostname
  // Beside the button rather than inside it: a field in a button is invalid
  // markup, and Chromium activated the button on every Space typed into it.
  filter_btn.before(inp)
  inp.focus()

  const close = () => {
    inp.remove()
    document.removeEventListener("click", dismissOnOutsideClick)
    if (openEditor?.input === inp) openEditor = null
  }
  const dismissOnOutsideClick = (clickEvent: MouseEvent) => {
    const target = clickEvent.target
    if (target === inp || (target instanceof Node && filter_btn.contains(target))) return
    close()
  }
  openEditor = { input: inp, close }
  // A swipe commits on pointerup, after which Chromium emits its corresponding
  // click. Installing the outside-click handler synchronously would see that
  // same click and immediately remove the input that the swipe just opened.
  setTimeout(() => {
    if (openEditor?.input === inp) document.addEventListener("click", dismissOnOutsideClick)
  })

  inp.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return
    e.preventDefault()
    close()
    if (!filter_btn.hidden) filter_btn.focus()
  })
  // Enter on keyup, not keydown: the confirm dialog focuses its primary
  // button at once, and the keypress that follows a keydown would press it.
  inp.addEventListener("keyup", (e) => {
    if (e.key === "Enter" && !e.isComposing) confirm_add_story(inp, callback)
  })
}

/** Closes the inline filter editor if it is open on a list row of `href`. */
export function close_filter_inputs(href: string): void {
  const row = openEditor?.input.closest<HTMLElement>(".story")
  if (row?.dataset.href === href && !row.closest("#selected_container")) {
    openEditor?.close()
  }
}

export function show_mobile_filter_dialog(
  story: Story,
  callback: (filter: string) => unknown
): void {
  const storiesPanel = requireElement<HTMLElement>("#stories_panel")
  void showTextInputDialog({
    message: "Filter stories matching:",
    value: new URL(story.href).hostname,
    confirmLabel: "Add filter",
    positionWithin: storiesPanel
  }).then((value) => {
    if (value === null) return
    callback(value)
  })
}

function confirm_add_story(
  inp: HTMLInputElement,
  callback: (filter: string) => unknown
) {
  const value = inp.value
  const storiesPanel = requireElement<HTMLElement>("#stories_panel")
  void showConfirmDialog({
    message: `Add filter: "${value}"?`,
    confirmLabel: "Add filter",
    positionWithin: storiesPanel
  }).then((confirmed) => {
    if (!confirmed) return
    callback(value)
    if (openEditor?.input === inp) openEditor.close()
    else inp.remove()
  })
}
