import { Story } from "@once/core"
import { requireElement } from "../dom"
import { showConfirmDialog, showTextInputDialog } from "../confirmDialog"

export function show_filter_dialog(
  event: MouseEvent,
  filter_btn: HTMLElement,
  story: Story,
  callback: (filter: string) => unknown
): void {
  event.stopPropagation()
  event.preventDefault()

  let inp = filter_btn.querySelector("input")

  //cancel other open inputs
  document
    .querySelectorAll(".story:not(.filtered) .filter_btn input")
    .forEach((x) => {
      if (inp != x) {
        x.outerHTML = ""
      }
    })

  if (inp) {
    if (event.target != inp) {
      confirm_add_story(inp, callback)
    }
    return
  }

  inp = document.createElement("input")
  inp.type = "text"
  inp.setAttribute("draggable", "false")
  inp.value = new URL(story.href).hostname
  filter_btn.prepend(inp)
  inp.focus()

  // A swipe commits on pointerup, after which Chromium emits its corresponding
  // click. Installing the outside-click handler synchronously would see that
  // same click and immediately remove the input that the swipe just opened.
  // Wait until the opening event sequence is over, and treat every descendant
  // of the filter button as inside the editor.
  const dismissOnOutsideClick = (clickEvent: MouseEvent) => {
    const target = clickEvent.target
    if (target instanceof Node && filter_btn.contains(target)) return
    document
      .querySelectorAll(".story:not(.filtered) .filter_btn input")
      .forEach((x) => {
        x.remove()
      })
    document.removeEventListener("click", dismissOnOutsideClick)
  }
  setTimeout(() => {
    document.addEventListener("click", dismissOnOutsideClick)
  })

  inp.addEventListener("keyup", (e) => {
    if (e.keyCode === 27) {
      //ESC
      inp.innerText = "filter"
    } else if (e.keyCode === 13) {
      //ENTER
      confirm_add_story(inp, callback)
    }
  })
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
    inp.remove()
  })
}
