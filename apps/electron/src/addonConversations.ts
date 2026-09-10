import { readConversationCommand } from "@once/core"
import type { AddonConversationHandle, AddonConversationSurface } from "@once/ui-web"
import type { ElectronBridge } from "@once/platform-electron/bridge"

/**
 * Continues a tray in a browser tab. The renderer keeps the conversation; main
 * only relays snapshots to the tab and the reader's input back, under a token
 * that ties the two together for as long as the tab shows the page.
 */
export function electronAddonConversations(bridge: ElectronBridge): AddonConversationSurface {
  const open = new Map<string, () => void>()
  bridge.addons.conversations.onCommand((token, command) => {
    const handle = handles.get(token)
    if (!handle) return
    try { handle.send(readConversationCommand(command)) }
    catch (error) { console.error("Ignoring an invalid conversation command", error) }
  })
  bridge.addons.conversations.onClosed(token => {
    open.get(token)?.()
    open.delete(token)
    handles.delete(token)
  })
  const handles = new Map<string, AddonConversationHandle>()
  return {
    label: "Continue in browser",
    open(handle) {
      const token = crypto.randomUUID()
      handles.set(token, handle)
      open.set(token, handle.subscribe(snapshot => bridge.addons.conversations.push(token, snapshot)))
      void bridge.addons.conversations.open(token, handle.snapshot()).catch(error => {
        console.error("Could not open the conversation tab", error)
        open.get(token)?.()
        open.delete(token)
        handles.delete(token)
      })
    }
  }
}
