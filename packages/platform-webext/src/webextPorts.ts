import { OncePlatformPorts, TabOpenerPort } from "@once/app"

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
      // Each event only says that the active tab may have changed; the tab is
      // read again here, and only the newest event's reading is reported. The
      // number is taken when the event arrives, before anything is awaited: one
      // navigation fires several onUpdated events, and when each awaited its own
      // lookups first, a late one about the page being left (its title, its
      // load completing) could finish last and report that page as open.
      let generation = 0
      // Any tab's event re-reads the active one: skipping it after taking a
      // number would drop the reading it superseded.
      const notifyActiveTab = async () => {
        const request = ++generation
        const [tab] = await browserApi.tabs.query({ currentWindow: true, active: true })
        if (request !== generation || !tab?.url) return
        const url = readerSourceUrl(browserApi, tab.url) ?? tab.url
        const context = await browserApi.runtime.sendMessage({ onceGetNavigation: tab.id, url }).catch(() => null)
        if (request === generation) handler(url, context ?? undefined)
      }
      const navigationListener = (message: { onceNavigationChanged?: number }) => {
        if (typeof message?.onceNavigationChanged === "number") void notifyActiveTab()
      }
      browserApi.runtime.onMessage.addListener(navigationListener)
      const activatedListener = () => void notifyActiveTab()
      const updatedListener = (_tabId: number, _changeInfo: browser.tabs._OnUpdatedChangeInfo, tab: browser.tabs.Tab) => {
        if (tab.active) void notifyActiveTab()
      }
      browserApi.tabs.onActivated.addListener(activatedListener)
      browserApi.tabs.onUpdated.addListener(updatedListener)
      void notifyActiveTab()
      return () => {
        generation += 1
        browserApi.runtime.onMessage.removeListener(navigationListener)
        browserApi.tabs.onActivated.removeListener(activatedListener)
        browserApi.tabs.onUpdated.removeListener(updatedListener)
      }
    }
  }
}

// Only our own stored-reader page may name a different story for the sidebar.
function readerSourceUrl(browserApi: typeof browser, value: string): string | null {
  try {
    const url = new URL(value)
    if (`${url.protocol}//${url.host}${url.pathname}` !== browserApi.runtime.getURL("static/reader.html")) return null
    const source = new URL(url.searchParams.get("sourceUrl") ?? "")
    return source.protocol === "https:" || source.protocol === "http:" ? source.href : null
  } catch {
    return null
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

/**
 * Opens another device's tab and, once the page has loaded, runs the script
 * that puts it where it was left. Reader-mode tabs open as pages: the
 * extension's reader keeps its documents to itself.
 */
export function createWebExtTabOpener(browserApi: typeof browser): TabOpenerPort {
  return {
    open(url, { background, restore }) {
      void browserApi.tabs.create({ url, active: !background }).then((tab) => {
        if (!restore || tab.id === undefined) return
        const tabId = tab.id
        const timeout = setTimeout(() => browserApi.tabs.onUpdated.removeListener(loaded), 60_000)
        const loaded = (updatedId: number, change: browser.tabs._OnUpdatedChangeInfo) => {
          if (updatedId !== tabId || change.status !== "complete") return
          clearTimeout(timeout)
          browserApi.tabs.onUpdated.removeListener(loaded)
          void browserApi.scripting.executeScript({ target: { tabId }, func: restore.fn as unknown as (...args: unknown[]) => void, args: restore.args })
            .catch((error) => console.warn("Could not restore the tab's position", error))
        }
        browserApi.tabs.onUpdated.addListener(loaded)
      }).catch((error) => console.error("Could not open the tab from another device", error))
    }
  }
}
