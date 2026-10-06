import { pageScriptSource, type OnceClient, type TabOpenerPort } from "@once/app"
import type { ElectronBridge } from "@once/platform-electron/bridge"
import { clientRemoteTabsPort, openSyncSettings, ReaderView } from "@once/ui-web"

/**
 * Feeds the tabs pages shown in this window's tabs with the same view the
 * side panel shows, and carries out what the reader picks there.
 */
export function hostRemoteTabsPages(bridge: ElectronBridge, client: OnceClient): void {
  const port = clientRemoteTabsPort(client)
  const pages = new Map<number, () => void>()
  // Screenshots go along with the view: the page has no database to ask.
  const thumbs = new Map<string, string>()
  const thumbsFor = async (state: Awaited<ReturnType<typeof port.load>>) => {
    const ids = (state.view?.devices ?? []).flatMap((device) => device.windows.flatMap((window) =>
      window.tabs.flatMap((tab) => tab.thumb ? [tab.thumb.id] : [])))
    for (const id of ids) {
      if (thumbs.has(id)) continue
      const src = await client.getTabThumbnail(id).catch(() => null)
      if (src) thumbs.set(id, src)
    }
    return Object.fromEntries(ids.flatMap((id) => thumbs.has(id) ? [[id, thumbs.get(id) as string]] : []))
  }
  // The page follows the shell's theme; "system" leaves it to the page's own media query.
  const push = (tabId: number) => void port.load().then(async (state) => {
    const images = await thumbsFor(state)
    if (pages.has(tabId)) bridge.remoteTabs.push(tabId, { ...state, thumbs: images, theme: document.body.dataset.theme ?? "" })
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
      const state = (command as { state?: unknown }).state
      client.openRemoteTab(command.url, command.mode === "reader" ? "reader" : "web", command.background === true,
        state && typeof state === "object" ? state as Parameters<OnceClient["openRemoteTab"]>[3] : undefined)
    }
  })
}

/**
 * Opens another device's tab here: a Reader-mode tab as a reader, anything
 * else as a page, with the script that puts it where it was left waiting
 * in main for the page to load.
 */
export function electronTabOpener(bridge: ElectronBridge): TabOpenerPort {
  return {
    open(url, { background, mode, restore }) {
      const target = background ? "middle" : "_self"
      const opened = restore ? bridge.tabSync.expectRestore(url, pageScriptSource(restore)) : Promise.resolve()
      void opened.then(() => mode === "reader" ? ReaderView.openWith(url, target) : bridge.tabs.openUrl(url, target))
        .catch((error) => console.error("Could not open the tab from another device", error))
    }
  }
}
