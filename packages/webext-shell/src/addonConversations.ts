import { readConversationCommand } from "@once/core"
import type { AddonConversationHandle, AddonConversationSurface } from "@once/ui-web"

/** Port names carry the token, so the page and the panel find each other without the background. */
export const CONVERSATION_PORT = "once-addon-conversation:"

/**
 * Continues a tray in a browser tab. The panel keeps the conversation and its
 * sandbox; the tab's page connects a runtime port named by the token, hears
 * every snapshot, and sends the reader's input back. When the panel closes,
 * the port disconnects and the page says so.
 */
/** `browserApi` is the extension's global; tests hand in their own. */
export function webextAddonConversations(browserApi: typeof browser = browser): AddonConversationSurface {
  const pending = new Map<string, AddonConversationHandle>()
  browserApi.runtime.onConnect.addListener(port => {
    if (!port.name.startsWith(CONVERSATION_PORT)) return
    const handle = pending.get(port.name.slice(CONVERSATION_PORT.length))
    if (!handle) { port.disconnect(); return }
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
    open(handle) {
      const token = crypto.randomUUID()
      pending.set(token, handle)
      void browserApi.tabs.create({
        url: browserApi.runtime.getURL(`static/addon-conversation.html?token=${encodeURIComponent(token)}`),
        active: true
      }).catch(error => { pending.delete(token); console.error("Could not open the conversation tab", error) })
    }
  }
}
