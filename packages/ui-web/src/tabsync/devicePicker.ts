/**
 * Asks which device a tab goes to: a small modal list of the devices that
 * can receive it. Resolves with the chosen device id, or null when cancelled.
 */
export function pickDevice(devices: ReadonlyArray<{ deviceId: string; name: string }>, title: string): Promise<string | null> {
  return new Promise((resolve) => {
    const dialog = document.createElement("dialog")
    dialog.className = "device_picker"
    dialog.dataset.testid = "device-picker"
    dialog.setAttribute("aria-label", title)
    const heading = document.createElement("p")
    heading.className = "device_picker_title"
    heading.textContent = title
    dialog.append(heading)
    let chosen: string | null = null
    if (!devices.length) {
      const empty = document.createElement("p")
      empty.className = "remote_tabs_notice"
      empty.textContent = "No other device can receive tabs yet."
      dialog.append(empty)
    }
    for (const device of devices) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "button"
      button.textContent = device.name
      button.addEventListener("click", () => { chosen = device.deviceId; dialog.close() })
      dialog.append(button)
    }
    const cancel = document.createElement("button")
    cancel.type = "button"
    cancel.className = "button"
    cancel.textContent = "Cancel"
    cancel.addEventListener("click", () => dialog.close())
    dialog.append(cancel)
    dialog.addEventListener("close", () => { dialog.remove(); resolve(chosen) }, { once: true })
    document.body.append(dialog)
    dialog.showModal()
  })
}
