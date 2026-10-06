import { pageScriptSource, type OnceClient, type TabOpenerPort } from "@once/app"
import type { ElectronBridge } from "@once/platform-electron/bridge"
import { clientRemoteTabsPort, openSyncSettings, ReaderView, sendTargets } from "@once/ui-web"

/**
 * Feeds the tabs pages shown in this window's tabs with the same view the
 * side panel shows, and carries out what the reader picks there.
 */
export function hostRemoteTabsPages(bridge: ElectronBridge, client: OnceClient): void {
  // The tab menu offers "Send Tab to Device" for the devices listed here.
  const reportTargets = () => void client.getTabSync().then((view) =>
    bridge.tabSync.setSendTargets(sendTargets(view?.devices ?? []).map(({ deviceId, name }) => ({ deviceId, name }))))
    .catch(() => undefined)
  client.subscribe("tabSyncChanged", reportTargets)
  reportTargets()
  bridge.tabSync.onSendTab((tabId, deviceId) => {
    void client.sendLocalTab(deviceId, tabId).catch((error) => console.error("Could not send the tab", error))
  })
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
    const command = value as { type?: unknown; url?: unknown; mode?: unknown; background?: unknown; id?: unknown; deviceId?: unknown; tab?: unknown }
    if (command.type === "settings") openSyncSettings((command as { page?: unknown }).page === "pair" ? "pair" : "tabs")
    else if (command.type === "open-sent" && typeof command.id === "string") void client.openSentTab(command.id, command.background === true)
    else if (command.type === "dismiss-sent" && typeof command.id === "string") void client.dismissSentTab(command.id)
    else if (command.type === "send" && typeof command.deviceId === "string" && command.tab && typeof command.tab === "object") {
      const tab = command.tab as { url?: unknown; title?: unknown; mode?: unknown; state?: unknown }
      if (typeof tab.url === "string") {
        void client.sendTab(command.deviceId, { url: tab.url, title: typeof tab.title === "string" ? tab.title : "",
          mode: tab.mode === "reader" ? "reader" : "web", state: tab.state as Parameters<OnceClient["sendTab"]>[1]["state"] })
          .catch((error) => console.error("Could not send the tab", error))
      }
    }
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
