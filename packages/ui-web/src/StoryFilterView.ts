import * as menu from "./menu"
import { Story } from "@once/core"
import { requireElement } from "./dom"
import { showConfirmDialog } from "./ConfirmDialog"

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

  document.addEventListener("click", (e) => {
    if (e.target != filter_btn) {
      document
        .querySelectorAll(".story:not(.filtered) .filter_btn input")
        .forEach((x) => {
          x.outerHTML = ""
        })
    }
  })

  inp = document.createElement("input")
  inp.type = "text"
  inp.setAttribute("draggable", "false")
  inp.value = new URL(story.href).hostname
  filter_btn.prepend(inp)
  inp.focus()
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

export function show_filter(value: string): void {
  if (value.startsWith(":: ")) {
    void showConfirmDialog({
      message: "Internal filters are not changeable yet.",
      cancelLabel: null
    })
    return
  }
  const filter_area = requireElement<HTMLInputElement>("#filter_area")

  const start = filter_area.value.indexOf(value)
  if (start == -1) {
    void showConfirmDialog({
      message: "Sorry, I seem to have lost that filter.",
      cancelLabel: null
    })
    return
  }

  menu.open_panel("settings")
  const end = start + value.length

  filter_area.focus()

  filter_area.scrollTop = 0
  const fullText = filter_area.value
  filter_area.value = fullText.substring(0, end)
  filter_area.scrollTop = filter_area.scrollHeight
  filter_area.value = fullText

  filter_area.setSelectionRange(start, end)
}
