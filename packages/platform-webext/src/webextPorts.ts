import { OncePlatformPorts } from "@once/app"

export function createWebExtActiveTab(
  browserApi: typeof browser,
  windowApi: Pick<Window, "open">
): OncePlatformPorts["activeTab"] {
  return {
    openUrl(url, target) {
      // "current" replaces what the active tab is showing. The panel is not a
      // tab, so unlike "_self" — which opens the story in a new one — there is
      // nothing here to navigate except the page the user is looking at.
      if (target === "current") {
        void browserApi.tabs
          .query({ active: true, currentWindow: true })
          .then((tabs) => {
            const id = tabs[0]?.id
            if (id !== undefined) return browserApi.tabs.update(id, { url })
          })
        return
      }
      if (target === "middle" || target === "_self") {
        void browserApi.tabs.create({ url, active: target === "_self" })
        return
      }
      windowApi.open(url, target)
    },
    onSelectedUrlChanged(handler) {
      let generation = 0
      const notifySelectedTab = async (tab: browser.tabs.Tab | undefined) => {
        const request = ++generation
        if (!tab?.url) return
        const context = await browserApi.runtime.sendMessage({ onceGetNavigation: tab.id, url: tab.url }).catch(() => null)
        if (request === generation) handler(tab.url, context ?? undefined)
      }
      const navigationListener = (message: { onceNavigationChanged?: number }) => {
        if (typeof message?.onceNavigationChanged !== "number") return
        void browserApi.tabs.query({ currentWindow: true, active: true }).then(tabs => {
          if (tabs[0]?.id === message.onceNavigationChanged) void notifySelectedTab(tabs[0])
        })
      }
      browserApi.runtime.onMessage.addListener(navigationListener)
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
        generation += 1
        browserApi.runtime.onMessage.removeListener(navigationListener)
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
