import type { RemoteDeviceView, TabSyncView } from "@once/app"
import type { SyncedTab } from "@once/core"
import type { ShowMenu } from "./devicePicker"
import { deviceRail, tabCount } from "./deviceRail"
import { foldableFilter } from "./foldableFilter"
import { notice, RemoteTabGroups } from "./remoteTabGroups"
import { ago } from "./remoteTabRows"

/** What the view needs, from the app client or from a page relaying to it. */
export interface RemoteTabsPort {
  load(): Promise<RemoteTabsState>
  subscribe(listener: () => void): () => void
  open(tab: Pick<SyncedTab, "url" | "mode" | "state">, background: boolean): void
  /** A tab's screenshot as a data URL, or null while it has not arrived. */
  thumbnail?(id: string): Promise<string | null>
  /** Sends a listed tab on to another device. */
  send?(deviceId: string, tab: Pick<SyncedTab, "url" | "title" | "mode" | "state">): Promise<void>
  /** Opens or dismisses a tab another device sent here. */
  openSent?(id: string, background: boolean): void
  dismissSent?(id: string): void
  /** Shows Settings › Sync › Tab sync, or Pair a device. */
  openSettings?(page?: "tabs" | "pair"): void
  /** Copies a tab's address; without it the row's menu leaves the entry out. */
  copyLink?(url: string): void
  /** The shell's own menu, where it has one (mobile's native sheet). */
  showMenu?: ShowMenu
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

export interface RemoteTabsOptions {
  /** Lists tabs sent here somewhere else than above the devices: mobile's tab view, above its own tabs. */
  inbox?: HTMLElement
  /** A heading over the summary, where the page has no title bar of its own: Electron's tabs page. */
  title?: string
  /** The filter waits behind a search button beside the summary: mobile, where room is short. */
  foldFilter?: boolean
}

/**
 * Other devices' tabs, grouped by device and window, with the tabs sent here
 * first. Rows are kept per tab and updated in place, so a list that changes
 * while it is read neither jumps nor blinks its screenshots; filter text and
 * folded devices survive re-renders and hiding.
 */
export function mountRemoteTabs(root: HTMLElement, port: RemoteTabsPort, options: RemoteTabsOptions = {}): RemoteTabsHandle {
  root.classList.add("remote_tabs")
  const toolbar = document.createElement("div")
  toolbar.className = "remote_tabs_toolbar"
  const { head, summary, settings } = viewHeader(port, options.title)
  const { search, filter } = filterField()
  if (options.foldFilter) foldableFilter(head, search, filter, () => render(true))
  const rail = document.createElement("div")
  rail.className = "remote_tabs_rail"
  rail.setAttribute("role", "group")
  rail.setAttribute("aria-label", "Show tabs from")
  rail.dataset.testid = "remote-tabs-rail"
  toolbar.append(search, rail)
  // The device the rail narrows the list to; null shows them all.
  let only: string | null = null
  const body = document.createElement("div")
  body.className = "remote_tabs_body"
  const feedback = document.createElement("div")
  feedback.className = "remote_tabs_feedback"
  feedback.setAttribute("role", "status")
  feedback.hidden = true
  root.replaceChildren(head, toolbar, feedback, body)
  const inboxHost = options.inbox ?? body
  let state: RemoteTabsState = { view: null, connected: false }
  const groups = new RemoteTabGroups(port, () => state, () => render(true), (message, retry) => {
    feedback.hidden = false
    feedback.textContent = message
    if (retry) {
      const button = document.createElement("button")
      button.type = "button"
      button.className = "button"
      button.textContent = "Retry"
      button.addEventListener("click", () => { feedback.textContent = "Sending…"; retry() })
      feedback.append(" ", button)
    }
  })
  let revision = 0
  let signature = ""

  const render = (force = false) => {
    const query = filter.value.trim().toLowerCase()
    // Re-rendering the same list would only move nodes; the times shown change by the minute.
    const next = JSON.stringify([state, query, only, Math.floor(Date.now() / 60_000)])
    if (!force && next === signature) return
    signature = next
    const empty = emptyState(state, port)
    toolbar.hidden = Boolean(empty)
    // A page keeps its title over an empty list; the empty notice brings its own settings button.
    summary.hidden = Boolean(empty)
    if (settings) settings.hidden = Boolean(empty)
    head.hidden = Boolean(empty) && !options.title
    if (empty) {
      body.replaceChildren(empty)
      if (inboxHost !== body) inboxHost.replaceChildren()
      return
    }
    const focused = document.activeElement as HTMLElement | null
    const focusKey = focused && (root.contains(focused) || inboxHost.contains(focused)) ? focused.dataset.focusKey : undefined
    const listed = groups.ordered()
    if (only && !listed.some((device) => device.deviceId === only)) only = null
    summary.textContent = summaryText(listed)
    deviceRail(rail, listed, only, (id) => { only = id; render(true) })
    const devices = groups.devices(query, only)
    const inbox = groups.inbox()
    const missing = query && !devices.length ? [notice(`No tabs match “${filter.value.trim()}”.`)] : []
    if (inboxHost === body) body.replaceChildren(...(inbox ? [inbox] : []), ...devices, ...missing)
    else {
      inboxHost.replaceChildren(...(inbox ? [inbox] : []))
      body.replaceChildren(...devices, ...missing)
    }
    groups.prune()
    if (focusKey) {
      const controls = [...root.querySelectorAll<HTMLElement>("[data-focus-key]"), ...inboxHost.querySelectorAll<HTMLElement>("[data-focus-key]")]
      const target = controls.find((control) => control.dataset.focusKey === focusKey)
      ;(target ?? filter).focus({ preventScroll: true })
    }
  }

  const refresh = () => {
    const current = ++revision
    void port.load().then((next) => {
      if (current !== revision) return
      state = next
      render()
    }, (error) => console.error("Could not load tabs from other devices", error))
  }

  filter.addEventListener("input", () => render(true))
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

function emptyState({ view, connected }: RemoteTabsState, port: RemoteTabsPort): HTMLElement | null {
  const settings = (label: string, page: "tabs" | "pair" = "tabs") =>
    port.openSettings ? [{ label, run: () => port.openSettings?.(page) }] : []
  if (!view) return notice("Tabs from other devices are not available here.")
  if (!view.options.enabled) return notice("Tab sync is off on this device.", settings("Turn on tab sync"))
  if (!connected && !view.devices.length) return notice("Connect sync to see tabs from your other devices.", settings("Sync settings"))
  if (!view.devices.length && !view.inbox.length) {
    return notice("No other devices yet. Turn on tab sync on another device, or pair one.", settings("Pair a device", "pair"))
  }
  return null
}

/** Sync settings sit with the title and summary, apart from the filter they do not belong to. */
function viewHeader(port: RemoteTabsPort, titleText?: string) {
  const head = document.createElement("div")
  head.className = "remote_tabs_head"
  const heading = document.createElement("div")
  heading.className = "remote_tabs_heading"
  if (titleText) {
    const title = document.createElement("h1")
    title.className = "remote_tabs_title"
    title.textContent = titleText
    heading.append(title)
  }
  const summary = document.createElement("span")
  summary.className = "remote_tabs_meta remote_tabs_summary"
  heading.append(summary)
  head.append(heading)
  const settings = port.openSettings ? settingsButton(() => port.openSettings?.("tabs")) : null
  if (settings) head.append(settings)
  return { head, summary, settings }
}

// Each list's filter gets its own id, for the button that unfolds it.
let filterIds = 0

/** The filter, a search field with its lens inside the frame. */
function filterField() {
  const search = document.createElement("label")
  search.className = "remote_tabs_search"
  const lens = document.createElement("span")
  lens.className = "icon icon--chrome icon--search"
  lens.setAttribute("aria-hidden", "true")
  const filter = document.createElement("input")
  filter.type = "search"
  filter.className = "remote_tabs_filter"
  filter.placeholder = "Filter by title or address"
  filter.setAttribute("aria-label", "Filter tabs from other devices")
  filter.dataset.testid = "remote-tabs-filter"
  filter.id = `remote_tabs_filter_${++filterIds}`
  search.append(lens, filter)
  return { search, filter }
}

/** "4 devices · 10 tabs · updated just now", over the filter: the newest word any device sent. */
function summaryText(devices: readonly RemoteDeviceView[]): string {
  const tabs = devices.reduce((total, device) => total + tabCount(device), 0)
  const newest = devices.map((device) => device.updatedAt).sort().at(-1)
  return [
    `${devices.length} device${devices.length === 1 ? "" : "s"}`,
    `${tabs} tab${tabs === 1 ? "" : "s"}`,
    ...(newest ? [`updated ${ago(newest)}`] : [])
  ].join(" · ")
}

function settingsButton(run: () => void): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "button remote_tabs_settings"
  button.title = "Tab sync settings"
  button.setAttribute("aria-label", "Tab sync settings")
  button.dataset.testid = "remote-tabs-settings"
  const icon = document.createElement("span")
  icon.className = "icon icon--chrome icon--gear"
  icon.setAttribute("aria-hidden", "true")
  const label = document.createElement("span")
  label.className = "remote_tabs_settings_label"
  label.textContent = "Sync settings"
  button.append(icon, label)
  button.addEventListener("click", run)
  return button
}


