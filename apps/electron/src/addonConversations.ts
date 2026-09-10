import { AddonConversationKey, conversationSearch, readConversationCommand, readConversationKey } from "@once/core"
import type { AddonConversationHandle, AddonConversationSurface } from "@once/ui-web"
import { ADDON_CONVERSATION_URL, ElectronBridge } from "@once/platform-electron/bridge"

/**
 * Continues a tray in a browser tab. The tab's URL names the conversation by
 * addon, tray and story; the renderer keeps the conversation and answers any
 * tab that asks for it, so the page also comes back through history. Main
 * only relays snapshots to the tab and the reader's input back.
 */
export function electronAddonConversations(bridge: ElectronBridge): AddonConversationSurface {
  let find: (key: AddonConversationKey) => AddonConversationHandle | null = () => null
  const attached = new Map<number, { handle: AddonConversationHandle; release: () => void }>()
  const detach = (tabId: number) => { attached.get(tabId)?.release(); attached.delete(tabId) }
  const keyOf = (value: unknown): AddonConversationKey | null => {
    const key = value as Partial<AddonConversationKey> | null
    return key && typeof key.addon === "string" && typeof key.tray === "string" && typeof key.story === "string"
      ? { addon: key.addon, tray: key.tray, story: key.story } : null
  }
  bridge.addons.conversations.onAttach((tabId, value) => {
    detach(tabId)
    const key = keyOf(value)
    const handle = key && find(key)
    if (!handle) { bridge.addons.conversations.push(tabId, null); return }
    attached.set(tabId, { handle, release: handle.subscribe(snapshot => bridge.addons.conversations.push(tabId, snapshot)) })
    bridge.addons.conversations.push(tabId, handle.snapshot())
  })
  bridge.addons.conversations.onDetach(detach)
  bridge.addons.conversations.onCommand((tabId, command) => {
    const handle = attached.get(tabId)?.handle
    if (!handle) return
    try { handle.send(readConversationCommand(command)) }
    catch (error) { console.error("Ignoring an invalid conversation command", error) }
  })
  return {
    label: "Continue in browser",
    connect(finder) { find = finder },
    // The shell mirrors the active tab's story above the browser; a
    // conversation page is about the story its URL names.
    storyHref: url => readConversationKey(url)?.story ?? null,
    open(handle) {
      const snapshot = handle.snapshot()
      const url = `${ADDON_CONVERSATION_URL}?${conversationSearch({ addon: snapshot.addon.id, tray: snapshot.tray.id, story: snapshot.story.href })}`
      void bridge.addons.conversations.open(url).catch(error => console.error("Could not open the conversation tab", error))
    }
  }
}
