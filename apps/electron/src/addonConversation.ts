// Entry of the addon conversation page in a browser tab. The shell still owns
// the conversation; this page mounts the shared view over the preload bridge.
import { readConversationSnapshot } from "@once/core"
import { mountAddonConversation, AddonConversationPort } from "@once/ui-web/addons/conversationPage"
import type { ElectronConversationPageBridge } from "@once/platform-electron/bridge"

declare global {
  interface Window { onceConversation?: ElectronConversationPageBridge }
}

function port(bridge: ElectronConversationPageBridge, token: string): AddonConversationPort {
  return {
    subscribe(listener) {
      const release = bridge.onState((snapshot, connected) => {
        try { listener(snapshot ? readConversationSnapshot(snapshot) : null, connected) }
        catch (error) { console.error("Ignoring an invalid conversation snapshot", error) }
      })
      void bridge.connect(token).then(snapshot => {
        if (snapshot) listener(readConversationSnapshot(snapshot), true)
        else listener(null, false)
      })
      return release
    },
    send: command => bridge.send(token, command)
  }
}

const root = document.getElementById("addon_conversation") ?? document.body
const token = new URLSearchParams(location.search).get("token") ?? ""
const bridge = window.onceConversation
if (!bridge || !token) {
  root.textContent = "This conversation page was opened without its Once panel. Open the story's tray again and continue from there."
} else {
  mountAddonConversation(root, port(bridge, token))
}
