import { pageMatchesCondition } from "@once/core"
import { PageActionMenuItem, pageActionMenuPatterns, readPageActionMenuItems } from "./pageActionMenuItems"

export interface PageActionMenuState {
  onceCommand: "page-actions-context"
  contextId: string
  items: PageActionMenuItem[]
}

export interface PageActionMenuRun {
  onceCommand: "page-addon-action"
  action: string
  contextId: string
  href: string
  title: string
}

export function isPageActionRunForContext(
  message: { onceCommand?: string; contextId?: string }, contextId: string
): message is PageActionMenuRun {
  return message.onceCommand === "page-addon-action" && message.contextId === contextId
}

const prefix = "once_page_"
const cacheKey = "oncePageActionMenus"

/** Menus retain descriptors across worker restarts; execution always finds a live panel. */
export function installPageActionMenuBackground(browserApi: typeof browser): void {
  const menus = browserApi.menus ?? browserApi.contextMenus
  if (!menus) throw new Error("The WebExtension menus API is unavailable")
  let known: PageActionMenuItem[] = []
  // Remember retained menu ids so removing an addon after a restart also
  // removes its old menu entries.
  let applying = browserApi.storage.local.get(cacheKey).then(saved => {
    known = readPageActionMenuItems(saved[cacheKey])
  })
  const ids = (id: string) => [prefix + id, prefix + "link:" + id]
  const apply = async (items: PageActionMenuItem[]): Promise<void> => {
    for (const item of known) {
      for (const id of ids(item.id)) await menus.remove(id).catch(() => undefined)
    }
    for (const item of items) {
      const patterns = pageActionMenuPatterns(item.when)
      if (!patterns.length) continue
      for (const [index, id] of ids(item.id).entries()) {
        await menus.remove(id).catch(() => undefined)
        menus.create({ id, title: item.label, contexts: [index ? "link" : "page"],
          documentUrlPatterns: index ? ["http://*/*", "https://*/*"] : patterns,
          ...(index ? { targetUrlPatterns: patterns } : {}) })
      }
    }
    known = items
    await browserApi.storage.local.set({ [cacheKey]: known })
  }
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    applying = applying.then(work).catch(error => console.error("Could not update page action menus", error))
    return applying
  }
  const target = (href: string): Promise<void> => enqueue(async () => {
    for (const item of known) {
      if (!pageActionMenuPatterns(item.when).length) continue
      for (const id of ids(item.id)) await menus.update(id, { enabled: pageMatchesCondition(item.when, href) })
    }
  })

  browserApi.runtime.onMessage.addListener((message, sender) => {
    if (message?.onceCommand === "page-actions-context" && typeof message.contextId === "string") {
      return enqueue(() => apply(readPageActionMenuItems(message.items)))
    }
    // Chrome reports the hovered/focused link ahead of opening its menu.
    // Firefox supplies the exact target through onShown below.
    if (message?.onceCommand === "page-actions-target" && sender.tab && typeof message.href === "string") {
      return target(message.href)
    }
    return undefined
  })
  browserApi.menus?.onShown.addListener(info => {
    const href = info.linkUrl ?? info.pageUrl
    if (href) void target(href).then(() => browserApi.menus.refresh())
  })

  menus.onClicked.addListener((info, tab) => {
    const id = String(info.menuItemId)
    if (!id.startsWith(prefix)) return
    const action = id.slice(prefix.length).replace(/^link:/, "")
    const href = info.linkUrl ?? info.pageUrl
    if (!href) return
    void (async () => {
      // A worker restart loses panel identity; an old identity can also name
      // a closed panel. Resolve a live panel in the clicked window each time.
      const state: PageActionMenuState | undefined = await browserApi.runtime.sendMessage({
        onceCommand: "page-actions-query", windowId: tab?.windowId
      })
      if (!state?.contextId) return
      const item = readPageActionMenuItems(state.items).find(item => item.id === action)
      if (!item || !pageMatchesCondition(item.when, href)) return
      const run: PageActionMenuRun = {
        onceCommand: "page-addon-action", action, contextId: state.contextId, href,
        title: info.linkUrl ? (info as { linkText?: string }).linkText ?? "" : tab?.title ?? ""
      }
      await browserApi.runtime.sendMessage(run)
    })().catch(error => console.error("Could not run page action; open the Once panel in this window", error))
  })
}
