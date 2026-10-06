import type { RemoteDeviceView, TabSyncView } from "@once/app"
import { humanTime, SyncedTab } from "@once/core"

/** What the view needs, from the app client or from a page relaying to it. */
export interface RemoteTabsPort {
  load(): Promise<RemoteTabsState>
  subscribe(listener: () => void): () => void
  open(tab: Pick<SyncedTab, "url" | "mode">, background: boolean): void
  /** Shows the Sync settings, where sync and sharing are set up. */
  openSettings?(): void
}

export interface RemoteTabsState {
  view: TabSyncView | null
  /** Sync is configured and allowed; without it nothing new arrives. */
  connected: boolean
}

export interface RemoteTabsHandle {
  refresh(): void
  dispose(): void
}

const PLATFORM_NAMES: Record<string, string> = {
  electron: "Desktop app", ios: "iOS", android: "Android", firefox: "Firefox", chrome: "Chrome"
}

/**
 * Other devices' tabs, grouped by device and window. Filter text and
 * collapsed devices survive re-renders and hiding, so new data arriving while
 * another panel is shown does not reset what the reader was doing.
 */
export function mountRemoteTabs(root: HTMLElement, port: RemoteTabsPort): RemoteTabsHandle {
  root.classList.add("remote_tabs")
  const filter = document.createElement("input")
  filter.type = "search"
  filter.className = "remote_tabs_filter"
  filter.placeholder = "Filter tabs"
  filter.setAttribute("aria-label", "Filter tabs from other devices")
  filter.dataset.testid = "remote-tabs-filter"
  const body = document.createElement("div")
  body.className = "remote_tabs_body"
  root.replaceChildren(filter, body)
  const collapsed = new Set<string>()
  let state: RemoteTabsState = { view: null, connected: false }
  let revision = 0

  const render = () => {
    const query = filter.value.trim().toLowerCase()
    const message = emptyMessage(state)
    if (message) {
      filter.hidden = true
      body.replaceChildren(notice(message, !state.connected && port.openSettings ? port.openSettings : undefined))
      return
    }
    filter.hidden = false
    const sections = (state.view?.devices ?? []).flatMap((device) => {
      const section = deviceSection(device, query, collapsed, port, render)
      return section ? [section] : []
    })
    body.replaceChildren(...(sections.length ? sections : [notice("No tabs match the filter.")]))
  }

  const refresh = () => {
    const current = ++revision
    void port.load().then((next) => {
      if (current !== revision) return
      state = next
      render()
    }, (error) => console.error("Could not load tabs from other devices", error))
  }

  filter.addEventListener("input", render)
  const release = port.subscribe(refresh)
  refresh()
  return {
    refresh,
    dispose: () => {
      revision++
      release()
    }
  }
}

function emptyMessage({ view, connected }: RemoteTabsState): string | null {
  if (!view) return "Tabs from other devices are not available here."
  if (!connected && !view.devices.length) return "Connect sync to see tabs from your other devices."
  if (!view.devices.length) return "No other devices yet. Turn on sharing in Settings › Sync on another device."
  return null
}

function deviceSection(
  device: RemoteDeviceView,
  query: string,
  collapsed: Set<string>,
  port: RemoteTabsPort,
  rerender: () => void
): HTMLElement | null {
  const windows = device.windows
    .map((entry) => ({ ...entry, tabs: entry.tabs.filter((tab) => matches(tab, query)) }))
    .filter((entry) => entry.tabs.length)
  if (query && !windows.length) return null
  const section = document.createElement("section")
  section.className = "remote_device"
  section.dataset.testid = "remote-device"
  if (device.stale) section.dataset.stale = "true"
  const open = query.length > 0 || !collapsed.has(device.deviceId)
  const header = document.createElement("button")
  header.type = "button"
  header.className = "remote_device_header"
  header.setAttribute("aria-expanded", String(open))
  const name = document.createElement("span")
  name.className = "remote_device_name"
  name.textContent = device.name
  const meta = document.createElement("span")
  meta.className = "remote_tabs_meta"
  meta.textContent = [
    PLATFORM_NAMES[device.platform] ?? device.platform,
    `seen ${humanTime(Date.parse(device.updatedAt))}`,
    ...(device.stale ? ["inactive"] : [])
  ].join(" · ")
  header.append(name, meta)
  header.addEventListener("click", () => {
    if (collapsed.has(device.deviceId)) collapsed.delete(device.deviceId)
    else collapsed.add(device.deviceId)
    rerender()
  })
  section.append(header)
  if (!open) return section
  if (!device.sharing || !device.windows.length) {
    section.append(notice(device.sharing ? "No open tabs." : "Not sharing its tabs."))
    return section
  }
  windows.forEach((entry, index) => {
    if (windows.length > 1 || entry.tabs.length > 1) {
      section.append(windowHeading(windows.length > 1 ? `Window ${index + 1}` : "", entry.tabs, port))
    }
    const list = document.createElement("ul")
    list.className = "remote_tab_list"
    list.append(...entry.tabs.map((tab) => tabRow(tab, port)))
    section.append(list)
  })
  return section
}

function windowHeading(label: string, tabs: SyncedTab[], port: RemoteTabsPort): HTMLElement {
  const heading = document.createElement("div")
  heading.className = "remote_window_heading"
  const text = document.createElement("span")
  text.className = "remote_tabs_meta"
  text.textContent = [label, `${tabs.length} tabs`].filter(Boolean).join(" · ")
  const all = document.createElement("button")
  all.type = "button"
  all.className = "button"
  all.textContent = "Open all"
  all.addEventListener("click", () => tabs.forEach((tab, index) => port.open(tab, index > 0)))
  heading.append(text, all)
  return heading
}

function tabRow(tab: SyncedTab, port: RemoteTabsPort): HTMLLIElement {
  const row = document.createElement("li")
  row.className = "remote_tab"
  row.dataset.testid = "remote-tab"
  const link = document.createElement("a")
  link.className = "remote_tab_link"
  link.href = tab.url
  link.title = tab.url
  const title = document.createElement("span")
  title.className = "remote_tab_title"
  title.textContent = tab.title || tab.url
  const detail = document.createElement("span")
  detail.className = "remote_tabs_meta"
  detail.textContent = [
    hostOf(tab.url),
    ...(tab.mode === "reader" ? ["Reader"] : []),
    `used ${humanTime(Date.parse(tab.activityAt))}`
  ].join(" · ")
  link.append(title, detail)
  // A link, so it can be focused, copied and middle-clicked like one; the
  // shell decides where it opens.
  link.addEventListener("click", (event) => {
    event.preventDefault()
    port.open(tab, Boolean(event.metaKey || event.ctrlKey || event.shiftKey))
  })
  link.addEventListener("auxclick", (event) => {
    if (event.button !== 1) return
    event.preventDefault()
    port.open(tab, true)
  })
  const background = document.createElement("button")
  background.type = "button"
  background.className = "button button--icon remote_tab_background"
  background.setAttribute("aria-label", `Open ${tab.title || "tab"} in the background`)
  background.title = "Open in the background"
  const icon = document.createElement("span")
  icon.className = "icon icon--chrome icon--plus"
  icon.setAttribute("aria-hidden", "true")
  background.append(icon)
  background.addEventListener("click", () => port.open(tab, true))
  row.append(link, background)
  return row
}

function notice(text: string, openSettings?: () => void): HTMLElement {
  const element = document.createElement("p")
  element.className = "remote_tabs_notice"
  element.textContent = text
  if (openSettings) {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "button"
    button.textContent = "Open sync settings"
    button.addEventListener("click", openSettings)
    element.append(" ", button)
  }
  return element
}

function matches(tab: SyncedTab, query: string): boolean {
  return !query || tab.title.toLowerCase().includes(query) || tab.url.toLowerCase().includes(query)
}

function hostOf(url: string): string {
  try {
    return new URL(url).host.replace(/^www\./, "")
  } catch {
    return url
  }
}
