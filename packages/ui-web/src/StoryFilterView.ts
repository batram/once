import * as menu from "./menu"
import { Story } from "@once/core"
import { requireElement } from "./dom"

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
  const existing = document.querySelector<HTMLDialogElement>(
    '[data-testid="confirm-dialog"]'
  )
  existing?.close()

  const dialog = document.createElement("dialog")
  dialog.classList.add("once-confirm-dialog")
  dialog.dataset.testid = "confirm-dialog"
  dialog.setAttribute("aria-labelledby", "confirm-dialog-message")

  const message = document.createElement("p")
  message.id = "confirm-dialog-message"
  message.textContent = `Add filter: "${value}"?`

  const actions = document.createElement("div")
  actions.classList.add("once-confirm-dialog__actions")
  const confirmButton = document.createElement("button")
  confirmButton.type = "button"
  confirmButton.classList.add("btn", "once-confirm-dialog__primary")
  confirmButton.dataset.testid = "confirm-accept"
  confirmButton.textContent = "Add filter"
  const cancelButton = document.createElement("button")
  cancelButton.type = "button"
  cancelButton.classList.add("btn")
  cancelButton.dataset.testid = "confirm-cancel"
  cancelButton.textContent = "Cancel"
  actions.append(confirmButton, cancelButton)
  dialog.append(message, actions)
  document.body.append(dialog)

  const storiesPanel = requireElement<HTMLElement>("#stories_panel")
  const positionDialog = () => {
    const rect = storiesPanel.getBoundingClientRect()
    dialog.style.left = `${Math.round(rect.left + rect.width / 2)}px`
    dialog.style.top = `${Math.round(rect.top + rect.height / 2)}px`
    dialog.style.setProperty(
      "--once-confirm-dialog-max-width",
      `${Math.max(160, Math.round(rect.width - 24))}px`
    )
  }
  const resizeObserver = new ResizeObserver(positionDialog)
  resizeObserver.observe(storiesPanel)
  window.addEventListener("resize", positionDialog)

  const close = () => dialog.close()
  dialog.addEventListener(
    "close",
    () => {
      resizeObserver.disconnect()
      window.removeEventListener("resize", positionDialog)
      dialog.remove()
    },
    { once: true }
  )
  confirmButton.addEventListener("click", () => {
    callback(value)
    inp.remove()
    close()
  })
  cancelButton.addEventListener("click", close)
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault()
    close()
  })
  positionDialog()
  dialog.showModal()
}

export function show_filter(value: string): void {
  if (value.startsWith(":: ")) {
    confirm("internal filter not changeable yet ...")
    return
  }
  const filter_area = requireElement<HTMLInputElement>("#filter_area")

  const start = filter_area.value.indexOf(value)
  if (start == -1) {
    confirm("Sorry I seem to have lost that fitler.")
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
