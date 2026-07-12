export interface ConfirmDialogOptions {
  message: string
  confirmLabel?: string
  cancelLabel?: string | null
  positionWithin?: HTMLElement
}

export function showConfirmDialog({
  message: messageText,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  positionWithin
}: ConfirmDialogOptions): Promise<boolean> {
  document
    .querySelector<HTMLDialogElement>('[data-testid="confirm-dialog"]')
    ?.close()

  const dialog = document.createElement("dialog")
  dialog.classList.add("once-confirm-dialog")
  dialog.dataset.testid = "confirm-dialog"
  dialog.setAttribute("aria-labelledby", "confirm-dialog-message")

  const message = document.createElement("p")
  message.id = "confirm-dialog-message"
  message.textContent = messageText

  const actions = document.createElement("div")
  actions.classList.add("once-confirm-dialog__actions")
  const confirmButton = document.createElement("button")
  confirmButton.type = "button"
  confirmButton.classList.add("btn", "once-confirm-dialog__primary")
  confirmButton.dataset.testid = "confirm-accept"
  confirmButton.textContent = confirmLabel
  actions.append(confirmButton)

  if (cancelLabel !== null) {
    const cancelButton = document.createElement("button")
    cancelButton.type = "button"
    cancelButton.classList.add("btn")
    cancelButton.dataset.testid = "confirm-cancel"
    cancelButton.textContent = cancelLabel
    cancelButton.addEventListener("click", () => dialog.close())
    actions.append(cancelButton)
  }

  dialog.append(message, actions)
  document.body.append(dialog)

  const positionDialog = () => {
    const rect = positionWithin?.getBoundingClientRect() ?? {
      left: 0,
      top: 0,
      width: window.innerWidth,
      height: window.innerHeight
    }
    dialog.style.left = `${Math.round(rect.left + rect.width / 2)}px`
    dialog.style.top = `${Math.round(rect.top + rect.height / 2)}px`
    dialog.style.setProperty(
      "--once-confirm-dialog-max-width",
      `${Math.max(160, Math.round(rect.width - 24))}px`
    )
  }

  const resizeObserver = positionWithin
    ? new ResizeObserver(positionDialog)
    : undefined
  if (positionWithin) resizeObserver?.observe(positionWithin)
  window.addEventListener("resize", positionDialog)

  return new Promise((resolve) => {
    let confirmed = false
    dialog.addEventListener(
      "close",
      () => {
        resizeObserver?.disconnect()
        window.removeEventListener("resize", positionDialog)
        dialog.remove()
        resolve(confirmed)
      },
      { once: true }
    )
    confirmButton.addEventListener("click", () => {
      confirmed = true
      dialog.close()
    })
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault()
      dialog.close()
    })
    positionDialog()
    dialog.showModal()
  })
}
