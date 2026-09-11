// Entry of the extension's addon conversation page: a tab that continues a
// tray's conversation, named by the page's URL. The panel keeps the
// conversation; this page shows what arrives over its runtime port and sends
// input back, on first load and again when history brings it back.
import browser from "webextension-polyfill"
import { readConversationKey, readConversationSnapshot } from "@once/core"
import { mountAddonConversation, AddonConversationPort } from "@once/ui-web/addons/conversationPage"
import { CONVERSATION_PORT } from "./addonConversations"

function connect(): AddonConversationPort {
  let port: ReturnType<typeof browser.runtime.connect> | null = null
  return {
    subscribe(listener) {
      let stopped = false
      let deadline: ReturnType<typeof setTimeout> | undefined
      let retry: ReturnType<typeof setTimeout> | undefined
      let detach: () => void = () => undefined
      const stop = () => {
        stopped = true
        clearTimeout(deadline)
        clearTimeout(retry)
        detach()
        port?.disconnect()
        port = null
      }
      const attach = () => {
        if (stopped) return
        // A broadcast port can disconnect when any receiving panel closes.
        // Reconnect to the named owner, with a deadline if it has gone away.
        deadline ??= setTimeout(() => { stop(); listener(null, false) }, 5000)
        const current = browser.runtime.connect({ name: CONVERSATION_PORT })
        port = current
        const onMessage = (message: unknown) => {
          const { snapshot, closed } = (message ?? {}) as { snapshot?: unknown; closed?: boolean }
          if (closed) { stop(); listener(null, false); return }
          try {
            const value = snapshot ? readConversationSnapshot(snapshot) : null
            clearTimeout(deadline)
            deadline = undefined
            listener(value, true)
          } catch (error) { console.error("Ignoring an invalid conversation snapshot", error) }
        }
        const onDisconnect = () => {
          detach()
          port = null
          if (!stopped) retry = setTimeout(attach, 100)
        }
        current.onMessage.addListener(onMessage)
        current.onDisconnect.addListener(onDisconnect)
        detach = () => {
          current.onMessage.removeListener(onMessage)
          current.onDisconnect.removeListener(onDisconnect)
        }
      }
      attach()
      return stop
    },
    send: command => port?.postMessage(command)
  }
}

const root = document.getElementById("addon_conversation") ?? document.body
if (!readConversationKey(location.href)) {
  root.textContent = "This page does not name a conversation. Open a story's tray in Once and continue from there."
} else {
  mountAddonConversation(root, connect())
}
