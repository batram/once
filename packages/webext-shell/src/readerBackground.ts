import "webextension-polyfill"
import { readerStyles } from "@once/ui-web/reader/readerDocument"

let activeReaderTabId: number | null = null

export function installReaderBackground(): void {
  browser.runtime.onMessage.addListener((message: {
    onceCommand?: string
    url?: string
    active?: boolean
    theme?: "system" | "light" | "dark"
    rate?: number
  }, sender) => {
    if (message?.onceCommand === "claimReaderTts") {
      const tabId = sender.tab?.id
      if (tabId == null) return undefined
      const previous = activeReaderTabId
      activeReaderTabId = tabId
      if (previous != null && previous !== tabId) {
        void browser.tabs.sendMessage(previous, {
          onceCommand: "stopReaderTts"
        }).catch(() => undefined)
      }
      return Promise.resolve()
    }
    if (message?.onceCommand === "releaseReaderTts") {
      if (sender.tab?.id === activeReaderTabId) activeReaderTabId = null
      return Promise.resolve()
    }
    if (message?.onceCommand === "getReaderTtsRate") {
      return browser.storage.local.get("onceReaderTtsRate").then((stored) => ({
        rate: stored.onceReaderTtsRate
      }))
    }
    if (message?.onceCommand === "setReaderTtsRate") {
      const rate = Number(message.rate)
      if (!Number.isFinite(rate) || rate < 0.5 || rate > 6) {
        throw new Error("Invalid reader TTS speed")
      }
      return browser.storage.local.set({ onceReaderTtsRate: rate })
    }
    if (message?.onceCommand !== "openReader" || !message.url) return undefined
    return openReaderTab(message.url, message.active !== false, message.theme || "system")
  })
  browser.tabs.onRemoved.addListener((tabId) => {
    if (tabId === activeReaderTabId) activeReaderTabId = null
  })
}

async function openReaderTab(
  url: string,
  active: boolean,
  theme: "system" | "light" | "dark"
): Promise<void> {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Reader source must use HTTP or HTTPS")
  }
  const tab = await browser.tabs.create({ url: parsed.toString(), active })
  if (tab.id == null) throw new Error("Reader tab was not created")
  await waitUntilLoaded(tab.id)
  await browser.scripting.executeScript({
    target: { tabId: tab.id },
    func: (configuredTheme: string) => {
      document.documentElement.setAttribute(
        "data-once-reader-theme",
        configuredTheme
      )
    },
    args: [theme]
  })
  await browser.scripting.insertCSS({
    target: { tabId: tab.id },
    css: readerStyles
  })
  await browser.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["/reader-content.js"]
  })
}

function waitUntilLoaded(tabId: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => finish(new Error("Timed out loading reader source")), 30000)
    const listener = (updatedId: number, change: browser.tabs._OnUpdatedChangeInfo) => {
      if (updatedId === tabId && change.status === "complete") finish()
    }
    const finish = (error?: Error) => {
      clearTimeout(timeout)
      browser.tabs.onUpdated.removeListener(listener)
      error ? reject(error) : resolve()
    }
    browser.tabs.onUpdated.addListener(listener)
    browser.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish()
    }, reject)
  })
}
