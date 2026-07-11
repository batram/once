import { OncePlatformPorts } from "@once/app"

export function createWebExtActiveTab(
  browserApi: typeof browser,
  windowApi: Pick<Window, "open">
): OncePlatformPorts["activeTab"] {
  return {
    openUrl(url, target) {
      if (target === "middle" || target === "_self") {
        void browserApi.tabs.create({ url, active: target === "_self" })
        return
      }
      windowApi.open(url, target)
    },
    onSelectedUrlChanged(handler) {
      const notifySelectedTab = (tab: browser.tabs.Tab | undefined) => {
        if (tab?.url) handler(tab.url)
      }
      const activatedListener = async (activeInfo: browser.tabs._OnActivatedActiveInfo) => {
        const win = await browserApi.windows.getCurrent()
        const tab = await browserApi.tabs.get(activeInfo.tabId)
        if (tab.windowId == win.id) notifySelectedTab(tab)
      }
      const updatedListener = async (
        _tabId: number,
        _changeInfo: browser.tabs._OnUpdatedChangeInfo,
        tab: browser.tabs.Tab
      ) => {
        const currentWindow = await browserApi.windows.getCurrent()
        if (tab.active && tab.windowId == currentWindow.id) notifySelectedTab(tab)
      }
      browserApi.tabs.onActivated.addListener(activatedListener)
      browserApi.tabs.onUpdated.addListener(updatedListener)
      void browserApi.tabs
        .query({ currentWindow: true, active: true })
        .then((tabs) => notifySelectedTab(tabs[0]))
      return () => {
        browserApi.tabs.onActivated.removeListener(activatedListener)
        browserApi.tabs.onUpdated.removeListener(updatedListener)
      }
    }
  }
}

export function createWebExtHistorySubscription(
  browserApi: typeof browser
): OncePlatformPorts["onHistoryCommand"] {
  return (handler) => {
    const listener = (message: { onceCommand?: string; action?: "undo" | "redo" }) => {
      if (
        message?.onceCommand === "history" &&
        (message.action === "undo" || message.action === "redo")
      ) {
        handler(message.action)
      }
    }
    browserApi.runtime.onMessage.addListener(listener)
    return () => browserApi.runtime.onMessage.removeListener(listener)
  }
}
