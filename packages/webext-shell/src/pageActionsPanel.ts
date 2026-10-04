import { PAGE_ADDON_ACTIONS_CHANGED, pageAddonActions, pageRunMode, runPageAddonAction } from "@once/ui-web"
import { PageActionMenuState, isPageActionRunForContext } from "./pageActionMenuBackground"

/**
 * The panel's side of the page context menu: it tells the background which
 * add-on actions exist, and runs the one chosen for a page or link. The
 * conversation then continues in a tab, as it does from a story's tray, or in
 * this panel when the reader chose that for the add-on.
 */
export async function bindPageActionsPanel(browserApi: typeof browser, contextId: string): Promise<void> {
  const windowId = (await browserApi.windows.getCurrent()).id
  const state = (): PageActionMenuState => ({
    onceCommand: "page-actions-context",
    contextId,
    // The placement travels with the entry: a click must open the side panel
    // inside its own user gesture, before the background could ask anyone.
    items: pageAddonActions("menu").map(({ id, label, when, place }) => ({ id, label, when, ...(place ? { place } : {}) }))
  })
  const publish = (): void => {
    void browserApi.runtime.sendMessage(state()).catch(() => undefined)
  }
  document.addEventListener(PAGE_ADDON_ACTIONS_CHANGED, publish)
  publish()
  browserApi.runtime.onMessage.addListener((message: { onceCommand?: string; contextId?: string; windowId?: number }) => {
    if (message.onceCommand === "page-actions-query") {
      if (message.windowId !== undefined && message.windowId !== windowId) return undefined
      return Promise.resolve(state())
    }
    if (!isPageActionRunForContext(message, contextId)) return
    if (typeof message.action !== "string" || typeof message.href !== "string") return
    runPageAddonAction(message.action, { href: message.href, title: typeof message.title === "string" ? message.title : "" }, pageRunMode(message.action))
    return undefined
  })
}
