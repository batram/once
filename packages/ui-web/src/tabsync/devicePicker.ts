import { openAnchoredMenu } from "../menu/storyAnchoredMenu"
import { ago } from "./remoteTabRows"

/** A device a tab can be sent to, as the view lists it. */
export interface SendTarget { deviceId: string; name: string; platform: string; updatedAt: string; stale?: boolean; sendTarget?: boolean }

/** One menu entry; the shell's own menu shows these where it has one (mobile's native sheet). */
export interface MenuChoice { id: string; label: string }

/** Shows `items` at `anchor` and resolves with the chosen id, or null when dismissed. */
export type ShowMenu = (anchor: HTMLElement | null, items: MenuChoice[], title?: string) => Promise<string | null>

/** The shared DOM menu, dropped under the button that asked for it. */
export const domMenu: ShowMenu = (anchor, items, title) => {
  if (!anchor) return pickFromDialog(items, title ?? "Choose")
  return new Promise((resolve) => {
    let chosen: string | null = null
    openAnchoredMenu({
      anchor,
      items: items.map((item) => ({ id: item.id, label: item.label, testid: `menu-${item.id}`, select: () => { chosen = item.id } })),
      // The menu closes before it runs the chosen item, in the same click.
      onClose: () => queueMicrotask(() => resolve(chosen))
    })
  })
}

/**
 * The devices a tab can go to: not the device it is on, not one gone
 * quiet for longer than the inactive limit.
 */
export function sendTargets<T extends SendTarget>(devices: readonly T[], from?: string): T[] {
  return devices.filter((device) => device.deviceId !== from && !device.stale && device.sendTarget !== false)
}

/**
 * Asks which device a tab goes to, as a menu at `anchor`: each device with
 * when it was last seen. Resolves with its id, or null.
 */
export async function chooseDevice(devices: readonly SendTarget[], anchor: HTMLElement | null,
  showMenu: ShowMenu = domMenu, from?: string): Promise<string | null> {
  const targets = sendTargets(devices, from)
  if (!targets.length) {
    await showMenu(anchor, [{ id: "none", label: "No other device can receive tabs yet" }], "Send to device")
    return null
  }
  const choice = await showMenu(anchor, targets.map((device) => ({
    id: device.deviceId,
    // Short enough for a one-line native menu; the name usually says what the device is.
    label: `${device.name} · ${ago(device.updatedAt)}`
  })), "Send to device")
  return targets.some((device) => device.deviceId === choice) ? choice : null
}

/** A small modal list, where nothing on screen can anchor a menu. */
function pickFromDialog(items: MenuChoice[], title: string): Promise<string | null> {
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
    for (const item of items) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "button device_picker_choice"
      button.textContent = item.label
      button.dataset.testid = `menu-${item.id}`
      button.addEventListener("click", () => { chosen = item.id; dialog.close() })
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
