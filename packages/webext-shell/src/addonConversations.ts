import { AddonConversationKey, conversationSearch, readConversationCommand, readConversationKey } from "@once/core"
import type { AddonConversationHandle, AddonConversationSurface } from "@once/ui-web"

/** The port name every conversation page connects with; its sender URL names the conversation. */
export const CONVERSATION_PORT = "once-addon-conversation"

/**
 * Continues a tray in a browser tab. The tab's URL names the conversation by
 * addon, tray, story and owning panel instance. The panel keeps the conversation and its sandbox; a
 * page showing that URL, first time or back through history, connects a
 * runtime port, hears every snapshot, and sends the reader's input back. When
 * the panel closes, the page becomes read-only. A reloaded panel has a new
 * identity: continue from its tray to open a fresh conversation tab.
 */
/** `browserApi` is the panel's polyfilled runtime: Chrome has no `browser` global of its own. */
export function webextAddonConversations(browserApi: typeof browser): AddonConversationSurface {
  const owner = crypto.randomUUID()
  const pageUrl = browserApi.runtime.getURL("static/addon-conversation.html")
  const pageKey = (value: string): AddonConversationKey | null => {
    try {
      const url = new URL(value)
      if (`${url.protocol}//${url.host}${url.pathname}` !== pageUrl) return null
      return readConversationKey(value)
    } catch { return null }
  }
  let find: (key: AddonConversationKey) => AddonConversationHandle | null = () => null
  browserApi.runtime.onConnect.addListener(port => {
    if (port.name !== CONVERSATION_PORT) return
    const senderUrl = port.sender?.url ?? ""
    const key = pageKey(senderUrl)
    // runtime.connect reaches every panel, including panels in other windows.
    // Only the panel that opened this tab may answer or process its commands.
    if (!key || new URL(senderUrl).searchParams.get("owner") !== owner) return
    const handle = key && find(key)
    if (!handle) { port.postMessage({ snapshot: null }); return }
    port.postMessage({ snapshot: handle.snapshot() })
    const release = handle.subscribe(snapshot => port.postMessage({ snapshot }))
    const closed = () => port.postMessage({ closed: true })
    globalThis.addEventListener?.("pagehide", closed, { once: true })
    port.onMessage.addListener(message => {
      try { handle.send(readConversationCommand(message)) }
      catch (error) { console.error("Ignoring an invalid conversation command", error) }
    })
    port.onDisconnect.addListener(() => {
      release()
      globalThis.removeEventListener?.("pagehide", closed)
    })
  })
  return {
    label: "Continue in a tab",
    storyHref: url => pageKey(url)?.story ?? null,
    connect(finder) { find = finder },
    open(handle) {
      const snapshot = handle.snapshot()
      const search = new URLSearchParams(conversationSearch({ addon: snapshot.addon.id, tray: snapshot.tray.id, story: snapshot.story.href }))
      search.set("owner", owner)
      void browserApi.tabs.create({ url: browserApi.runtime.getURL(`static/addon-conversation.html?${search}`), active: true })
        .catch(error => console.error("Could not open the conversation tab", error))
    }
  }
}
