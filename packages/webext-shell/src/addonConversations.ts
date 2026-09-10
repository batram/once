import { AddonConversationKey, conversationSearch, readConversationCommand, readConversationKey } from "@once/core"
import type { AddonConversationHandle, AddonConversationSurface } from "@once/ui-web"

/** The port name every conversation page connects with; its sender URL names the conversation. */
export const CONVERSATION_PORT = "once-addon-conversation"

/**
 * Continues a tray in a browser tab. The tab's URL names the conversation by
 * addon, tray and story. The panel keeps the conversation and its sandbox; a
 * page showing that URL, first time or back through history, connects a
 * runtime port, hears every snapshot, and sends the reader's input back. When
 * the panel closes, the port disconnects and the page says so.
 */
/** `browserApi` is the panel's polyfilled runtime: Chrome has no `browser` global of its own. */
export function webextAddonConversations(browserApi: typeof browser): AddonConversationSurface {
  let find: (key: AddonConversationKey) => AddonConversationHandle | null = () => null
  browserApi.runtime.onConnect.addListener(port => {
    if (port.name !== CONVERSATION_PORT) return
    const key = readConversationKey(port.sender?.url ?? "")
    const handle = key && find(key)
    if (!handle) { port.postMessage({ snapshot: null }); return }
    port.postMessage({ snapshot: handle.snapshot() })
    const release = handle.subscribe(snapshot => port.postMessage({ snapshot }))
    port.onMessage.addListener(message => {
      try { handle.send(readConversationCommand(message)) }
      catch (error) { console.error("Ignoring an invalid conversation command", error) }
    })
    port.onDisconnect.addListener(() => release())
  })
  return {
    label: "Continue in a tab",
    connect(finder) { find = finder },
    open(handle) {
      const snapshot = handle.snapshot()
      const search = conversationSearch({ addon: snapshot.addon.id, tray: snapshot.tray.id, story: snapshot.story.href })
      void browserApi.tabs.create({ url: browserApi.runtime.getURL(`static/addon-conversation.html?${search}`), active: true })
        .catch(error => console.error("Could not open the conversation tab", error))
    }
  }
}
