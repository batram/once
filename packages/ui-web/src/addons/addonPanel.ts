// The Once panel as a place for a page's add-on conversation: beside the page
// it is about, rather than in a tab that covers it. Chosen per add-on in its
// settings, it is mostly reached from a page's context menu. The panel and its
// menu button exist only while a conversation is shown there, and go away
// when it is closed or the conversation ends.
import { TemporaryPanel } from "../shell/temporaryPanel"
import type { AddonConversationHandle, AddonConversationSurface } from "./AddonTrays"
import { AddonConversationPort, mountAddonConversation } from "./conversationPage"
import { pageAddonActions } from "./pageAddons"

/** The `active_panel` name of the add-on conversation panel. */
export const ADDON_PANEL = "addon"

/**
 * The add-on as its menu button names it: the short name it declares, its name
 * when that fits, or the initials of a longer one ("What? Wait, who, why?" is WWWW).
 */
export function menuName(addon: { name: string; shortName?: string }): string {
  if (addon.shortName) return addon.shortName
  if (addon.name.length <= 12) return addon.name
  return (addon.name.match(/[\p{L}\p{N}]+/gu) ?? []).map(word => word[0].toUpperCase()).join("").slice(0, 6) || addon.name.slice(0, 12)
}

/** Shows page conversations in the Once panel; the surface `mountAddons` opens the panel choice with. */
export function addonPanelConversations(): AddonConversationSurface {
  let shown: { panel: TemporaryPanel; unmount: () => void } | null = null
  const close = (): void => {
    if (!shown) return
    const { panel, unmount } = shown
    shown = null
    unmount()
    panel.remove()
  }
  const port = (handle: AddonConversationHandle): AddonConversationPort => ({
    subscribe(listener) {
      listener(handle.snapshot(), true)
      // A conversation that ended (the add-on was reset, disabled or removed) takes its panel along.
      return handle.subscribe(snapshot => { if (snapshot) listener(snapshot, true); else queueMicrotask(close) })
    },
    send: command => handle.send(command)
  })
  return {
    label: "Show in the Once panel",
    open(handle) {
      // One conversation at a time: a new one takes the place of the last.
      shown?.unmount()
      const panel = shown?.panel ?? TemporaryPanel.create(ADDON_PANEL, close)
      if (!panel) return
      const snapshot = handle.snapshot()
      const action = pageAddonActions("menu").find(item => item.id.startsWith(`addon:${snapshot.addon.id}/`))
      panel.label(action?.icon ?? "ai-question", menuName(snapshot.addon), snapshot.addon.name)
      shown = { panel, unmount: mountAddonConversation(panel.body, port(handle), true) }
      panel.show()
    }
  }
}
