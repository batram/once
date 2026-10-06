import type { TabSyncView } from "@once/app"
import type { SyncedTab } from "@once/core"
import type { ShowMenu } from "./devicePicker"
import { notice, RemoteTabGroups } from "./remoteTabGroups"

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
  const filter = document.createElement("input")
  filter.type = "search"
  filter.className = "remote_tabs_filter"
  filter.placeholder = "Filter tabs"
  filter.setAttribute("aria-label", "Filter tabs from other devices")
  filter.dataset.testid = "remote-tabs-filter"
  toolbar.append(filter)
  if (port.openSettings) toolbar.append(settingsButton(() => port.openSettings?.("tabs")))
  const body = document.createElement("div")
  body.className = "remote_tabs_body"
  root.replaceChildren(toolbar, body)
  const inboxHost = options.inbox ?? body
  let state: RemoteTabsState = { view: null, connected: false }
  const groups = new RemoteTabGroups(port, () => state, () => render(true))
  let revision = 0
  let signature = ""

  const render = (force = false) => {
    const query = filter.value.trim().toLowerCase()
    // Re-rendering the same list would only move nodes; the times shown change by the minute.
    const next = JSON.stringify([state, query, Math.floor(Date.now() / 60_000)])
    if (!force && next === signature) return
    signature = next
    const empty = emptyState(state, port)
    toolbar.hidden = Boolean(empty)
    if (empty) {
      body.replaceChildren(empty)
      if (inboxHost !== body) inboxHost.replaceChildren()
      return
    }
    const devices = groups.devices(query)
    const inbox = groups.inbox()
    const missing = query && !devices.length ? [notice(`No tabs match “${filter.value.trim()}”.`)] : []
    if (inboxHost === body) body.replaceChildren(...(inbox ? [inbox] : []), ...devices, ...missing)
    else {
      inboxHost.replaceChildren(...(inbox ? [inbox] : []))
      body.replaceChildren(...devices, ...missing)
    }
    groups.prune()
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




function settingsButton(run: () => void): HTMLButtonElement {
  const button = document.createElement("button")
  button.type = "button"
  button.className = "button button--icon remote_tabs_settings"
  button.title = "Tab sync settings"
  button.setAttribute("aria-label", "Tab sync settings")
  button.dataset.testid = "remote-tabs-settings"
  const icon = document.createElement("span")
  icon.className = "icon icon--chrome icon--gear"
  icon.setAttribute("aria-hidden", "true")
  button.append(icon)
  button.addEventListener("click", run)
  return button
}


