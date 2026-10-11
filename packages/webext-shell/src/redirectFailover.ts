import { OnceClient } from "@once/app"

interface LoadFailedMessage {
  onceLoadFailed?: { tabId?: unknown; url?: unknown; reason?: unknown }
}

/**
 * A tab whose page failed to load, as the background saw it. When an add-on
 * redirect produced that page and has moved elsewhere, the tab follows. Each
 * window's panel answers for its own tabs only, so two open panels never
 * move the same rule twice.
 */
export function bindRedirectFailover(api: typeof browser, client: OnceClient): void {
  const ownWindow = api.windows.getCurrent().then((window) => window.id).catch(() => undefined)
  api.runtime.onMessage.addListener((message: LoadFailedMessage, sender) => {
    const failed = message?.onceLoadFailed
    if (sender.id !== api.runtime.id || !failed) return
    const { tabId, url, reason } = failed
    if (typeof tabId !== "number" || typeof url !== "string" || typeof reason !== "string") return
    void (async () => {
      const [windowId, tab] = await Promise.all([ownWindow, api.tabs.get(tabId)])
      if (windowId === undefined || tab.windowId !== windowId) return
      const next = await client.reportRedirectFailure(url, reason)
      if (next) await api.tabs.update(tabId, { url: next })
    })().catch((error) => console.error("Redirect failover failed", error))
  })
}
