import "webextension-polyfill"
import { readerStyles } from "@once/ui-web/reader/readerDocument"

export function installReaderBackground(): void {
  browser.runtime.onMessage.addListener((message: {
    onceCommand?: string
    url?: string
    active?: boolean
    theme?: "system" | "light" | "dark"
  }) => {
    if (message?.onceCommand !== "openReader" || !message.url) return undefined
    return openReaderTab(message.url, message.active !== false, message.theme || "system")
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
