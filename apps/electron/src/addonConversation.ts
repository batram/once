// Entry of the addon conversation page in a browser tab. The page's URL names
// the conversation; the shell still owns it, and this page mounts the shared
// view over the preload bridge, on first load and again whenever history
// brings the page back.
import { readConversationKey, readConversationSnapshot } from "@once/core"
import { mountAddonConversation, AddonConversationPort } from "@once/ui-web/addons/conversationPage"
import type { ElectronConversationPageBridge } from "@once/platform-electron/bridge"

declare global {
  interface Window { onceConversation?: ElectronConversationPageBridge }
}

function port(bridge: ElectronConversationPageBridge): AddonConversationPort {
  return {
    subscribe(listener) {
      const release = bridge.onState((snapshot, connected) => {
        try { listener(snapshot ? readConversationSnapshot(snapshot) : null, connected) }
        catch (error) { console.error("Ignoring an invalid conversation snapshot", error) }
      })
      void bridge.connect().catch(() => listener(null, false))
      return release
    },
    send: command => bridge.send(command)
  }
}

const root = document.getElementById("addon_conversation") ?? document.body
const bridge = window.onceConversation
if (!bridge || !readConversationKey(location.href)) {
  root.textContent = "This page does not name a conversation. Open a story's tray in Once and continue from there."
} else {
  mountAddonConversation(root, port(bridge))
}
