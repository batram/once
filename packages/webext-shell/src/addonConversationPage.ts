// Entry of the extension's addon conversation page: a tab that continues a
// tray's conversation, named by the page's URL. The panel keeps the
// conversation; this page shows what arrives over its runtime port and sends
// input back, on first load and again when history brings it back.
import browser from "webextension-polyfill"
import { readConversationKey, readConversationSnapshot } from "@once/core"
import { mountAddonConversation, AddonConversationPort } from "@once/ui-web/addons/conversationPage"
import { CONVERSATION_PORT } from "./addonConversations"

function connect(): AddonConversationPort {
  const port = browser.runtime.connect({ name: CONVERSATION_PORT })
  return {
    subscribe(listener) {
      const onMessage = (message: unknown) => {
        const { snapshot } = (message ?? {}) as { snapshot?: unknown }
        try { listener(snapshot ? readConversationSnapshot(snapshot) : null, true) }
        catch (error) { console.error("Ignoring an invalid conversation snapshot", error) }
      }
      const onDisconnect = () => listener(null, false)
      port.onMessage.addListener(onMessage)
      port.onDisconnect.addListener(onDisconnect)
      return () => {
        port.onMessage.removeListener(onMessage)
        port.onDisconnect.removeListener(onDisconnect)
      }
    },
    send: command => port.postMessage(command)
  }
}

const root = document.getElementById("addon_conversation") ?? document.body
if (!readConversationKey(location.href)) {
  root.textContent = "This page does not name a conversation. Open a story's tray in Once and continue from there."
} else {
  mountAddonConversation(root, connect())
}
