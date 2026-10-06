import type { OnceClient } from "@once/app"
import { mountRemoteTabs, RemoteTabsPort } from "./RemoteTabsView"
import { SYNC_PAGE_EVENT, type SyncPage } from "../settings/syncSettingsPages"

/** The view's port over the app client, for shells that run the app themselves. */
export function clientRemoteTabsPort(client: OnceClient): RemoteTabsPort {
  return {
    load: async () => ({
      view: await client.getTabSync().catch(() => null),
      connected: client.getSyncStatus().state !== "disabled"
    }),
    subscribe(listener) {
      const releases = [
        client.subscribe("tabSyncChanged", listener),
        client.subscribe("syncStatusChanged", listener)
      ]
      return () => releases.forEach((release) => release())
    },
    open: (tab, background) => client.openRemoteTab(tab.url, tab.mode, background, tab.state),
    thumbnail: (id) => client.getTabThumbnail(id),
    send: (deviceId, tab) => client.sendTab(deviceId, tab),
    openSent: (id, background) => void client.openSentTab(id, background),
    dismissSent: (id) => void client.dismissSentTab(id),
    openSettings: (page) => openSyncSettings(page ?? "tabs"),
    copyLink: (url) => void navigator.clipboard.writeText(url).catch(() => undefined)
  }
}

/** Shows Settings › Sync, or one of its pages: Tab sync from the tabs list. */
export function openSyncSettings(page: SyncPage = "overview"): void {
  document.querySelector<HTMLElement>("#settings_menu_btn")?.click()
  document.querySelector<HTMLButtonElement>("[data-settings-target=\"sync\"]")?.click()
  document.dispatchEvent(new CustomEvent<SyncPage>(SYNC_PAGE_EVENT, { detail: page }))
}

/**
 * Calls `listener` with whether tab sync is on for this device, now and on
 * every change. Off, a shell shows no entry, button or menu for it.
 */
export function watchTabSyncEnabled(client: OnceClient, listener: (enabled: boolean) => void): void {
  let last: boolean | null = null
  const check = () => void client.getTabSync().then((view) => {
    const enabled = view?.options.enabled === true
    if (enabled === last) return
    last = enabled
    listener(enabled)
  }, () => undefined)
  client.subscribe("tabSyncChanged", check)
  check()
}

// The shell wants the entry (a platform or placement choice) and tab sync is on.
let menuWanted = false
let menuEnabled = false

/**
 * The Tabs entry in the side panel menu and its panel. The entry is a
 * permanent one, right after Stories; temporary entries (an add-on thread,
 * a story's comments) still go to the bottom of the menu after it.
 */
export function mountTabsPanel(client: OnceClient, visible: boolean): void {
  const host = document.querySelector<HTMLElement>("#remote_tabs")
  if (!host) return
  mountRemoteTabs(host, clientRemoteTabsPort(client))
  setTabsMenuVisible(visible)
  watchTabSyncEnabled(client, (enabled) => {
    menuEnabled = enabled
    applyTabsMenu()
  })
}

/** Whether this shell offers the Tabs menu entry; it shows only while tab sync is on too. */
export function setTabsMenuVisible(visible: boolean): void {
  menuWanted = visible
  applyTabsMenu()
}

/** A hidden entry's open panel gives way to the stories. */
function applyTabsMenu(): void {
  const button = document.querySelector<HTMLElement>("#tabs_menu_btn")
  if (!button) return
  const visible = menuWanted && menuEnabled
  button.hidden = !visible
  if (!visible && document.querySelector("#left_panel")?.getAttribute("active_panel") === "tabs") {
    document.querySelector<HTMLElement>("#stories_menu_btn > button.heading")?.click()
  }
}
