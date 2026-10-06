import type { OnceClient } from "@once/app"
import { mountRemoteTabs, RemoteTabsPort } from "./RemoteTabsView"

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
    open: (tab, background) => client.openRemoteTab(tab.url, tab.mode, background),
    thumbnail: (id) => client.getTabThumbnail(id),
    openSettings: openSyncSettings
  }
}

/** Shows Settings › Sync. */
export function openSyncSettings(): void {
  document.querySelector<HTMLElement>("#settings_menu_btn")?.click()
  document.querySelector<HTMLButtonElement>("[data-settings-target=\"sync\"]")?.click()
}

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
}

/** Shows or hides the Tabs menu entry; a hidden entry's open panel gives way to the stories. */
export function setTabsMenuVisible(visible: boolean): void {
  const button = document.querySelector<HTMLElement>("#tabs_menu_btn")
  if (!button) return
  button.hidden = !visible
  if (!visible && document.querySelector("#left_panel")?.getAttribute("active_panel") === "tabs") {
    document.querySelector<HTMLElement>("#stories_menu_btn > button.heading")?.click()
  }
}
