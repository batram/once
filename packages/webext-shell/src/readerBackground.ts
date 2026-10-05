import {
  isReaderTtsRate,
  normalizeReaderTtsPreferences
} from "@once/ui-web/reader/readerTtsPreferences"
import { isExtensionPageSender, isTabContentSender } from "./messageSender"

const STORED_READER_PREFIX = "onceStoredReader:"

interface StoredReaderDocument {
  html: string
  sourceUrl: string
}

export function installReaderBackground(
  browserApi: typeof browser = browser
): () => void {
  let activeReaderTabId: number | null = null
  const messageListener = (message: {
    onceCommand?: string
    url?: string
    active?: boolean
    theme?: "system" | "light" | "dark"
    preferences?: { voice?: unknown; rates?: Record<string, unknown> }
    html?: string
    sourceUrl?: string
    token?: string
  }, sender: browser.runtime.MessageSender) => {
    if (message?.onceCommand === "claimReaderTts") {
      if (!isTabContentSender(sender) && !isExtensionPageSender(browserApi, sender, "reader")) return undefined
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
      if (!isTabContentSender(sender) && !isExtensionPageSender(browserApi, sender, "reader")) return undefined
      if (sender.tab?.id === activeReaderTabId) activeReaderTabId = null
      return Promise.resolve()
    }
    if (message?.onceCommand === "getReaderTtsPreferences") {
      if (!isTabContentSender(sender) && !isExtensionPageSender(browserApi, sender, "reader")) return undefined
      return browserApi.storage.local
        .get(["onceReaderTtsPreferences", "onceReaderTtsRate"])
        .then((stored) => normalizeReaderTtsPreferences(
          stored.onceReaderTtsPreferences,
          stored.onceReaderTtsRate
        ))
    }
    if (message?.onceCommand === "setReaderTtsPreferences") {
      if (!isTabContentSender(sender) && !isExtensionPageSender(browserApi, sender, "reader")) return undefined
      const preferences = message.preferences
      const rates = preferences?.rates
      if (
        typeof preferences?.voice !== "string" ||
        !rates || typeof rates !== "object" ||
        !Object.values(rates).every(isReaderTtsRate)
      ) {
        throw new Error("Invalid reader TTS settings")
      }
      return browserApi.storage.local.set({
        onceReaderTtsPreferences: normalizeReaderTtsPreferences(preferences)
      })
    }
    if (message?.onceCommand === "openStoredReader") {
      if (!isExtensionPageSender(browserApi, sender, "sidepanel")) return undefined
      if (typeof message.html !== "string" || !message.html) {
        throw new Error("A stored reader document is required")
      }
      return openStoredReaderTab(
        browserApi,
        { html: message.html, sourceUrl: message.sourceUrl ?? "" },
        message.active !== false
      )
    }
    if (message?.onceCommand === "getStoredReader") {
      if (!isExtensionPageSender(browserApi, sender, "reader")) return undefined
      if (typeof message.token !== "string") return undefined
      return takeStoredReader(browserApi, message.token)
    }
    if (message?.onceCommand !== "openReader" || !message.url) return undefined
    if (!isExtensionPageSender(browserApi, sender, "sidepanel")) return undefined
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
    files: ["/reader.css"]
  })
  await browserApi.scripting.executeScript({
    target: { tabId: tab.id },
    files: ["/reader-content.js"]
  })
}

/**
 * Session storage where the browser has it, so a document survives the
 * service worker being put to sleep between the tab opening and asking; local
 * storage otherwise. Either way the entry is removed once read.
 */
function readerStorage(browserApi: typeof browser): browser.storage.StorageArea {
  const storage = browserApi.storage as typeof browser.storage & {
    session?: browser.storage.StorageArea
  }
  return storage.session ?? storage.local
}

async function openStoredReaderTab(
  browserApi: typeof browser,
  document: StoredReaderDocument,
  active: boolean
): Promise<void> {
  const token = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  await readerStorage(browserApi).set({ [`${STORED_READER_PREFIX}${token}`]: document })
  await browserApi.tabs.create({
    url: browserApi.runtime.getURL(`static/reader.html?token=${encodeURIComponent(token)}`),
    active
  })
}

async function takeStoredReader(
  browserApi: typeof browser,
  token: string
): Promise<StoredReaderDocument | null> {
  const key = `${STORED_READER_PREFIX}${token}`
  const storage = readerStorage(browserApi)
  const stored = await storage.get(key)
  const document = stored[key] as StoredReaderDocument | undefined
  if (!document) return null
  await storage.remove(key)
  return document
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
      if (error) reject(error)
      else resolve()
    }
    browserApi.tabs.onUpdated.addListener(listener)
    browserApi.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish()
    }, reject)
  })
}
