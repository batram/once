import { sameStoryDocument, StoryPageContext } from "@once/core"

interface DocumentContext extends StoryPageContext {
  url: string
  requestId: string
}

/** Track document identity in the background, including while the side panel is closed. */
export function installStoryNavigationBackground(api: typeof browser): void {
  const pending = new Map<number, Promise<void>>()
  const key = (id: number) => `once:document:${id}`
  const storage = api.storage.session
  const update = (tabId: number, change: (previous?: DocumentContext) => DocumentContext | undefined) => {
    if (tabId < 0) return
    const task = (pending.get(tabId) ?? Promise.resolve()).then(async () => {
      const name = key(tabId)
      const previous = (await storage.get(name))[name] as DocumentContext | undefined
      const next = change(previous)
      if (!next) return
      await storage.set({ [name]: next })
      await api.runtime.sendMessage({ onceNavigationChanged: tabId }).catch(() => undefined)
    }).catch(error => console.error("Unable to track story navigation", error))
    pending.set(tabId, task)
    void task.finally(() => { if (pending.get(tabId) === task) pending.delete(tabId) })
  }
  const filter = { urls: ["http://*/*", "https://*/*"], types: ["main_frame" as const] }
  api.webRequest.onBeforeRequest.addListener(details => {
    update(details.tabId, previous => previous?.requestId === details.requestId
      ? { ...previous, url: details.url }
      : { url: details.url, sourceUrl: sameStoryDocument(previous?.url, details.url)
        ? previous?.sourceUrl ?? details.url : details.url, requestId: details.requestId })
  }, filter)
  api.webRequest.onBeforeRedirect.addListener(details => {
    update(details.tabId, previous => previous?.requestId === details.requestId
      ? { ...previous, url: details.redirectUrl } : undefined)
  }, filter)
  api.webRequest.onHeadersReceived.addListener(details => {
    if (details.statusCode >= 300 && details.statusCode < 400) return
    update(details.tabId, previous => previous?.requestId === details.requestId
      ? { ...previous, url: details.url, statusCode: details.statusCode } : undefined)
  }, filter)
  api.webRequest.onErrorOccurred.addListener(details => {
    update(details.tabId, previous => previous?.requestId === details.requestId
      ? { ...previous, failed: true } : undefined)
  }, filter)
  const sameDocument = (details: browser.webNavigation._OnHistoryStateUpdatedDetails) => {
    if (details.frameId !== 0) return
    update(details.tabId, previous => previous ? { ...previous, url: details.url } : undefined)
  }
  api.webNavigation.onHistoryStateUpdated.addListener(sameDocument)
  api.webNavigation.onReferenceFragmentUpdated.addListener(sameDocument)
  api.tabs.onRemoved.addListener(tabId => {
    void (pending.get(tabId) ?? Promise.resolve()).then(() => storage.remove(key(tabId)))
  })
  api.runtime.onMessage.addListener((message, sender) => {
    if (sender.id !== api.runtime.id || typeof message?.onceGetNavigation !== "number") return undefined
    const tabId = message.onceGetNavigation
    return (pending.get(tabId) ?? Promise.resolve()).then(async () => {
      const record = (await storage.get(key(tabId)))[key(tabId)] as DocumentContext | undefined
      return record && (sameStoryDocument(record.url, message.url) || record.failed && sameStoryDocument(record.sourceUrl, message.url)) ? record : null
    })
  })
}
