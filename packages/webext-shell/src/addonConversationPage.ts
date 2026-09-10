// Entry of the extension's addon conversation page: a tab that continues a
// tray's conversation. The panel keeps the conversation; this page shows what
// arrives over the runtime port named by its token and sends input back.
import browser from "webextension-polyfill"
import { readConversationSnapshot } from "@once/core"
import { mountAddonConversation, AddonConversationPort } from "@once/ui-web/addons/conversationPage"
import { CONVERSATION_PORT } from "./addonConversations"

function connect(token: string): AddonConversationPort {
  const port = browser.runtime.connect({ name: `${CONVERSATION_PORT}${token}` })
  return {
    subscribe(listener) {
      const onMessage = (message: unknown) => {
        const { snapshot } = (message ?? {}) as { snapshot?: unknown }
        try { listener(readConversationSnapshot(snapshot), true) }
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
const token = new URLSearchParams(location.search).get("token") ?? ""
if (!token) {
  root.textContent = "This conversation page was opened without its Once panel. Open the story's tray again and continue from there."
} else {
  mountAddonConversation(root, connect(token))
}
