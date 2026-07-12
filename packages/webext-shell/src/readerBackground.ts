import { readerStyles } from "@once/ui-web/reader/readerDocument"

export function installReaderBackground(
  browserApi: typeof browser = browser
): () => void {
  let activeReaderTabId: number | null = null
  const messageListener = (message: {
    onceCommand?: string
    url?: string
    active?: boolean
    theme?: "system" | "light" | "dark"
    rate?: number
  }, sender: browser.runtime.MessageSender) => {
    if (message?.onceCommand === "claimReaderTts") {
      const tabId = sender.tab?.id
      if (tabId == null) return undefined
      const previous = activeReaderTabId
      activeReaderTabId = tabId
      if (previous != null && previous !== tabId) {
        void browserApi.tabs.sendMessage(previous, {
          onceCommand: "stopReaderTts"
        }).catch((): void => undefined)
      }
      return Promise.resolve()
    }
    if (message?.onceCommand === "releaseReaderTts") {
      if (sender.tab?.id === activeReaderTabId) activeReaderTabId = null
      return Promise.resolve()
    }
    if (message?.onceCommand === "getReaderTtsRate") {
      return browserApi.storage.local.get("onceReaderTtsRate").then((stored) => ({
        rate: stored.onceReaderTtsRate
      }))
    }
    if (message?.onceCommand === "setReaderTtsRate") {
      const rate = Number(message.rate)
      if (!Number.isFinite(rate) || rate < 0.5 || rate > 6) {
        throw new Error("Invalid reader TTS speed")
      }
      return browserApi.storage.local.set({ onceReaderTtsRate: rate })
    }
    if (message?.onceCommand !== "openReader" || !message.url) return undefined
    return openReaderTab(browserApi, message.url, message.active !== false, message.theme || "system")
  }
  const removedListener = (tabId: number) => {
    if (tabId === activeReaderTabId) activeReaderTabId = null
  }
  browserApi.runtime.onMessage.addListener(messageListener)
  browserApi.tabs.onRemoved.addListener(removedListener)
  return () => {
    browserApi.runtime.onMessage.removeListener(messageListener)
    browserApi.tabs.onRemoved.removeListener(removedListener)
  }
}

async function openReaderTab(
  browserApi: typeof browser,
  url: string,
  active: boolean,
  theme: "system" | "light" | "dark"
): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Reader source must use HTTP or HTTPS")
  }
  const tab = await browserApi.tabs.create({ url: parsed.toString(), active })
  if (tab.id == null) throw new Error("Reader tab was not created")
  await waitUntilLoaded(browserApi, tab.id)
  await browserApi.scripting.executeScript({
    target: { tabId: tab.id },
    func: (configuredTheme: string) => {
      document.documentElement.setAttribute(
        "data-once-reader-theme",
        configuredTheme
      )
    },
    args: [theme]
  })
  await browserApi.scripting.insertCSS({
    target: { tabId: tab.id },
    css: readerStyles
  })
  await browserApi.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["/reader-content.js"]
  })
}

function waitUntilLoaded(browserApi: typeof browser, tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Timed out loading reader source")), 30000)
    const listener = (updatedId: number, change: browser.tabs._OnUpdatedChangeInfo) => {
      if (updatedId === tabId && change.status === "complete") finish()
    }
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      browserApi.tabs.onUpdated.removeListener(listener)
      error ? reject(error) : resolve()
    }
    browserApi.tabs.onUpdated.addListener(listener)
    browserApi.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish()
    }, reject)
  })
}
