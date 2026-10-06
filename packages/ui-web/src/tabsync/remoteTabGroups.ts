import type { RemoteDeviceView, SentTabView } from "@once/app"
import type { SyncedTab } from "@once/core"
import { chooseDevice, domMenu, sendTargets } from "./devicePicker"
import { platformName } from "./devicePresentation"
import { ago, tabRow, ThumbnailCache, updateSentRow, updateTabRow } from "./remoteTabRows"
import type { RemoteTabsPort, RemoteTabsState } from "./RemoteTabsView"

/**
 * The list's groups: tabs sent here and each device's windows. Rows and
 * sections are kept by key and refilled, so a new snapshot updates the list
 * in place; folding chosen by the reader is remembered here too.
 */
export class RemoteTabGroups {
  private readonly rows = new Map<string, HTMLLIElement>()
  private readonly sections = new Map<string, HTMLElement>()
  // Folding the user chose; a device not in either set takes its default.
  private readonly folded = new Set<string>()
  private readonly unfolded = new Set<string>()
  private readonly thumbs: ThumbnailCache

  constructor(private readonly port: RemoteTabsPort, private readonly state: () => RemoteTabsState, private readonly rerender: () => void) {
    this.thumbs = new ThumbnailCache(port.thumbnail)
  }

  /** Devices in order, quiet ones last; null when the filter leaves nothing. */
  devices(query: string): HTMLElement[] {
    const devices = [...this.state().view?.devices ?? []].sort((a, b) => Number(isQuiet(a)) - Number(isQuiet(b)))
    return devices.flatMap((device) => this.device(device, query) ?? [])
  }

  inbox(): HTMLElement | null {
    const inbox: SentTabView[] = this.state().view?.inbox ?? []
    const port = this.port
    if (!inbox.length || !port.openSent) return null
    const section = this.section("inbox")
    section.className = "remote_device remote_inbox"
    section.dataset.testid = "remote-inbox"
    const heading = document.createElement("h3")
    heading.className = "remote_group_title"
    heading.textContent = "Sent to this device"
    const list = document.createElement("ul")
    list.className = "remote_tab_list"
    list.replaceChildren(...inbox.map((sent) => {
      const element = this.row(`sent/${sent.id}`)
      updateSentRow(element, sent, {
        open: (background) => port.openSent?.(sent.id, background),
        dismiss: port.dismissSent ? () => port.dismissSent?.(sent.id) : undefined
      }, this.thumbs)
      return element
    }))
    section.replaceChildren(heading, list)
    return section
  }

  /**
   * Folded or filtered rows are kept for when they show again; only a tab
   * that is gone loses its row.
   */
  prune(): void {
    const view = this.state().view
    const listed = new Set([
      ...(view?.devices ?? []).flatMap((device) => device.windows.flatMap((entry) =>
        entry.tabs.map((tab) => `${device.deviceId}/${tab.id}`))),
      ...(view?.inbox ?? []).map((sent) => `sent/${sent.id}`)
    ])
    for (const key of this.rows.keys()) if (!listed.has(key)) this.rows.delete(key)
  }

  private device(device: RemoteDeviceView, query: string): HTMLElement | null {
    const windows = device.windows
      .map((entry) => ({ ...entry, tabs: entry.tabs.filter((tab) => matches(tab, query)) }))
      .filter((entry) => entry.tabs.length)
    if (query && !windows.length) return null
    const quiet = isQuiet(device)
    const open = query.length > 0 || (quiet ? this.unfolded.has(device.deviceId) : !this.folded.has(device.deviceId))
    const section = this.section(device.deviceId)
    section.className = "remote_device"
    section.dataset.testid = "remote-device"
    section.dataset.quiet = String(quiet)
    const all = windows.flatMap((entry) => entry.tabs)
    const header = deviceHeader(device, open, () => {
      const set = quiet ? this.unfolded : this.folded
      if (set.has(device.deviceId)) set.delete(device.deviceId)
      else set.add(device.deviceId)
      this.rerender()
    }, open && windows.length === 1 && all.length > 1 ? () => this.openAll(all) : undefined)
    const children: HTMLElement[] = [header]
    if (open) {
      if (!device.sharing || !device.windows.length) {
        children.push(notice(device.sharing ? "No open tabs." : "Not sharing its tabs."))
      }
      windows.forEach((entry, index) => {
        if (windows.length > 1) children.push(windowHeading(`Window ${index + 1}`, entry.tabs, () => this.openAll(entry.tabs)))
        const list = document.createElement("ul")
        list.className = "remote_tab_list"
        list.replaceChildren(...entry.tabs.map((tab) => {
          const element = this.row(`${device.deviceId}/${tab.id}`)
          updateTabRow(element, tab, {
            open: (background) => this.port.open(tab, background),
            more: (anchor) => this.tabMenu(anchor, tab, device.deviceId)
          }, this.thumbs)
          return element
        }))
        children.push(list)
      })
    }
    section.replaceChildren(...children)
    return section
  }

  private tabMenu(anchor: HTMLElement, tab: SyncedTab, from: string): void {
    const port = this.port
    const showMenu = port.showMenu ?? domMenu
    const devices = this.state().view?.devices ?? []
    const items = [
      { id: "background", label: "Open in background" },
      ...(port.send && sendTargets(devices, from).length ? [{ id: "send", label: "Send to device…" }] : []),
      ...(port.copyLink ? [{ id: "copy", label: "Copy link" }] : [])
    ]
    void showMenu(anchor, items, tab.title || tab.url).then(async (choice) => {
      if (choice === "background") port.open(tab, true)
      else if (choice === "copy") port.copyLink?.(tab.url)
      else if (choice === "send") {
        const target = await chooseDevice(devices, anchor.isConnected ? anchor : null, showMenu, from)
        if (target) await port.send?.(target, tab)
      }
    }).catch((error) => console.error("Could not send the tab", error))
  }

  private openAll(tabs: SyncedTab[]): void {
    tabs.forEach((tab, index) => this.port.open(tab, index > 0))
  }

  private row(key: string): HTMLLIElement {
    let element = this.rows.get(key)
    if (!element) { element = tabRow(); this.rows.set(key, element) }
    return element
  }

  private section(key: string): HTMLElement {
    let element = this.sections.get(key)
    if (!element) { element = document.createElement("section"); this.sections.set(key, element) }
    return element
  }
}

/** Gone quiet or keeping its tabs to itself: listed last, folded until opened. */
function isQuiet(device: RemoteDeviceView): boolean {
  return device.stale || !device.sharing
}

function deviceHeader(device: RemoteDeviceView, open: boolean, toggle: () => void, openAll?: () => void): HTMLElement {
  const header = document.createElement("div")
  header.className = "remote_device_header"
  const button = document.createElement("button")
  button.type = "button"
  button.className = "remote_device_toggle"
  button.setAttribute("aria-expanded", String(open))
  const chevron = document.createElement("span")
  chevron.className = "remote_device_chevron"
  chevron.setAttribute("aria-hidden", "true")
  chevron.textContent = "›"
  const text = document.createElement("span")
  text.className = "remote_device_text"
  const name = document.createElement("span")
  name.className = "remote_device_name"
  name.textContent = device.name
  const meta = document.createElement("span")
  meta.className = "remote_tabs_meta"
  const count = device.windows.reduce((total, entry) => total + entry.tabs.length, 0)
  meta.textContent = [
    platformName(device.platform),
    device.sharing ? `${count} tab${count === 1 ? "" : "s"}` : "not sharing",
    device.stale ? `inactive, seen ${ago(device.updatedAt)}` : ago(device.updatedAt)
  ].join(" · ")
  text.append(name, meta)
  button.append(chevron, text)
  button.addEventListener("click", toggle)
  header.append(button)
  if (openAll) header.append(openAllButton(count, openAll))
  return header
}

function windowHeading(label: string, tabs: SyncedTab[], openAll: () => void): HTMLElement {
  const heading = document.createElement("div")
  heading.className = "remote_window_heading"
  const text = document.createElement("span")
  text.className = "remote_tabs_meta"
  text.textContent = `${label} · ${tabs.length} tab${tabs.length === 1 ? "" : "s"}`
  heading.append(text)
  if (tabs.length > 1) heading.append(openAllButton(tabs.length, openAll))
  return heading
}

function openAllButton(count: number, run: () => void): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "button remote_open_all"
  button.textContent = "Open all"
  button.setAttribute("aria-label", `Open all ${count} tabs`)
  button.addEventListener("click", run)
  return button
}

export function notice(text: string, actions: Array<{ label: string; run: () => void }> = []): HTMLElement {
  const element = document.createElement("div")
  element.className = "remote_tabs_notice"
  element.dataset.testid = "remote-tabs-notice"
  const message = document.createElement("p")
  message.textContent = text
  element.append(message)
  for (const action of actions) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "button"
    button.textContent = action.label
    button.addEventListener("click", action.run)
    element.append(button)
  }
  return element
}

function matches(tab: SyncedTab, query: string): boolean {
  return !query || tab.title.toLowerCase().includes(query) || tab.url.toLowerCase().includes(query)
}
