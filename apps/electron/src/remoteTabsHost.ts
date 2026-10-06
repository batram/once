import type { OnceClient } from "@once/app"
import type { ElectronBridge } from "@once/platform-electron/bridge"
import { clientRemoteTabsPort, openSyncSettings } from "@once/ui-web"

/**
 * Feeds the tabs pages shown in this window's tabs with the same view the
 * side panel shows, and carries out what the reader picks there.
 */
export function hostRemoteTabsPages(bridge: ElectronBridge, client: OnceClient): void {
  const port = clientRemoteTabsPort(client)
  const pages = new Map<number, () => void>()
  // The page follows the shell's theme; "system" leaves it to the page's own media query.
  const push = (tabId: number) => void port.load().then((state) => {
    if (pages.has(tabId)) bridge.remoteTabs.push(tabId, { ...state, theme: document.body.dataset.theme ?? "" })
  })
  client.subscribe("settingsChanged", ({ section }) => {
    if (section === "theme") for (const tabId of pages.keys()) push(tabId)
  })
  bridge.remoteTabs.onAttach((tabId) => {
    pages.get(tabId)?.()
    pages.set(tabId, port.subscribe(() => push(tabId)))
    push(tabId)
  })
  bridge.remoteTabs.onDetach((tabId) => {
    pages.get(tabId)?.()
    pages.delete(tabId)
  })
  bridge.remoteTabs.onCommand((tabId, value) => {
    if (!pages.has(tabId) || !value || typeof value !== "object") return
    const command = value as { type?: unknown; url?: unknown; mode?: unknown; background?: unknown }
    if (command.type === "settings") openSyncSettings()
    else if (command.type === "open" && typeof command.url === "string") {
      client.openRemoteTab(command.url, command.mode === "reader" ? "reader" : "web", command.background === true)
    }
  })
}
