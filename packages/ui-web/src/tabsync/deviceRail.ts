import type { RemoteDeviceView } from "@once/app"

/** How many tabs a device lists, across its windows. */
export function tabCount(device: RemoteDeviceView): number {
  return device.windows.reduce((total, entry) => total + entry.tabs.length, 0)
}

/**
 * The chips under the filter: all devices, then each one with its tab count.
 * Choosing one narrows the list to that device; with a single device there
 * is nothing to choose, so the rail hides.
 */
export function deviceRail(rail: HTMLElement, devices: readonly RemoteDeviceView[], only: string | null,
  choose: (deviceId: string | null) => void): void {
  rail.hidden = devices.length < 2
  if (rail.hidden) { rail.replaceChildren(); return }
  const total = devices.reduce((sum, device) => sum + tabCount(device), 0)
  rail.replaceChildren(
    chip("All", total, only === null, () => choose(null), "rail:all"),
    ...devices.map((device) => chip(device.name, tabCount(device), only === device.deviceId,
      () => choose(device.deviceId), `rail:${device.deviceId}`))
  )
}

function chip(label: string, count: number, pressed: boolean, run: () => void, focusKey: string): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "remote_tabs_chip"
  button.dataset.testid = "remote-tabs-chip"
  button.dataset.focusKey = focusKey
  button.setAttribute("aria-pressed", String(pressed))
  button.setAttribute("aria-label", `${label}, ${count} tab${count === 1 ? "" : "s"}`)
  const name = document.createElement("span")
  name.className = "remote_tabs_chip_name"
  name.textContent = label
  const number = document.createElement("span")
  number.className = "remote_tabs_chip_count"
  number.textContent = String(count)
  button.append(name, number)
  button.addEventListener("click", run)
  return button
}
