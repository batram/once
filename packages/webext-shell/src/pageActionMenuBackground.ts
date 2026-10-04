import { pageMatchesCondition } from "@once/core"
import { PageActionMenuItem, pageActionMenuPatterns, readPageActionMenuItems } from "./pageActionMenuItems"
import { isExtensionPageSender, isTabContentSender } from "./messageSender"
import { PAGE_ACTION_RUN } from "./addonConversations"

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

/**
 * The menu entries exist from the moment the extension does. Until a panel
 * has published the add-ons it actually has, they are the `defaults`: the
 * actions of the add-ons this build carries, which every first start installs.
 * After that, the panel's last published list is kept and rebuilt on every
 * background start, so entries survive browser restarts without a panel.
 * A click runs in the live panel of its window, or, with none open, in a
 * conversation tab of its own.
 */
export function installPageActionMenuBackground(
  browserApi: typeof browser, defaults: PageActionMenuItem[] | Promise<PageActionMenuItem[]> = []
): void {
  const menus = browserApi.menus ?? browserApi.contextMenus
  if (!menus) throw new Error("The WebExtension menus API is unavailable")
  let known: PageActionMenuItem[] = []
  // Remember retained menu ids so removing an addon after a restart also
  // removes its old menu entries.
  let applying = browserApi.storage.local.get(cacheKey).then(async saved => {
    known = readPageActionMenuItems(saved[cacheKey])
    await apply(cacheKey in saved ? known : readPageActionMenuItems(await defaults))
  }).catch(error => console.error("Could not restore page action menus", error))
  // Loading this script is what rebuilds the menus; a listener makes the browser load it at startup.
  browserApi.runtime.onStartup?.addListener(() => undefined)
  const ids = (id: string) => [prefix + id, prefix + "link:" + id]
  // Firefox matches targetUrlPatterns against a media element's srcUrl too,
  // and a link around a streamed video (YouTube's hover previews) has none it
  // can parse: the check throws and takes every extension item after it out
  // of the menu. Firefox shows link entries for every web page instead and
  // hides those whose link does not match when the menu opens (onShown).
  // Chrome checks only the link, and has no onShown, so it keeps the filter.
  const filtersOnShow = Boolean(browserApi.menus?.onShown)
  const apply = async (items: PageActionMenuItem[]): Promise<void> => {
    for (const item of known) {
      for (const id of ids(item.id)) await menus.remove(id).catch(() => undefined)
    }
    for (const item of items) {
      const patterns = pageActionMenuPatterns(item.when)
      if (!patterns.length) continue
      for (const [index, id] of ids(item.id).entries()) {
        await menus.remove(id).catch(() => undefined)
        menus.create({ id, title: index ? `${item.label} for Link` : item.label, contexts: [index ? "link" : "page"],
          documentUrlPatterns: index ? ["http://*/*", "https://*/*"] : patterns,
          ...(index && !filtersOnShow ? { targetUrlPatterns: patterns } : {}) })
      }
    }
    known = items
    await browserApi.storage.local.set({ [cacheKey]: known })
  }
  const enqueue = (work: () => Promise<void>): Promise<void> => {
    applying = applying.then(work).catch(error => console.error("Could not update page action menus", error))
    return applying
  }
  const target = (href: string, link?: string): Promise<void> => enqueue(async () => {
    for (const item of known) {
      if (!pageActionMenuPatterns(item.when).length) continue
      for (const id of ids(item.id)) await menus.update(id, { enabled: pageMatchesCondition(item.when, href) })
      // What targetUrlPatterns would have hidden, decided from the link alone.
      if (link !== undefined) {
        await menus.update(ids(item.id)[1], { visible: /^https?:/i.test(link) && pageMatchesCondition(item.when, link) })
      }
    }
  })

  browserApi.runtime.onMessage.addListener((message, sender) => {
    if (message?.onceCommand === "page-actions-context" && typeof message.contextId === "string") {
      if (!isExtensionPageSender(browserApi, sender, "sidepanel")) return undefined
      return enqueue(() => apply(readPageActionMenuItems(message.items)))
    }
    // Chrome reports the hovered/focused link ahead of opening its menu.
    // Firefox supplies the exact target through onShown below.
    if (message?.onceCommand === "page-actions-target" && isTabContentSender(sender) && typeof message.href === "string") {
      return target(message.href)
    }
    return undefined
  })
  browserApi.menus?.onShown.addListener(info => {
    const href = info.linkUrl ?? info.pageUrl
    if (href) void target(href, info.linkUrl).then(() => browserApi.menus.refresh())
  })

  menus.onClicked.addListener((info, tab) => {
    const id = String(info.menuItemId)
    if (!id.startsWith(prefix)) return
    const action = id.slice(prefix.length).replace(/^link:/, "")
    const href = info.linkUrl ?? info.pageUrl
    if (!href) return
    const title = info.linkUrl ? (info as { linkText?: string }).linkText ?? "" : tab?.title ?? ""
    void (async () => {
      // A worker restart loses panel identity; an old identity can also name
      // a closed panel. Resolve a live panel in the clicked window each time.
      // With no panel listening at all, sending rejects rather than answering.
      const state: PageActionMenuState | undefined = await browserApi.runtime.sendMessage({
        onceCommand: "page-actions-query", windowId: tab?.windowId
      }).catch(() => undefined)
      if (!state?.contextId) {
        // No panel in this window: a conversation tab runs the action itself.
        // A click can wake the worker: the retained items load from storage first.
        await enqueue(async () => undefined)
        const item = known.find(item => item.id === action)
        if (!item || !pageMatchesCondition(item.when, href)) return
        const search = new URLSearchParams({ [PAGE_ACTION_RUN]: action, href, title })
        await browserApi.tabs.create({
          url: browserApi.runtime.getURL(`static/addon-conversation.html?${search}`),
          active: true, windowId: tab?.windowId, ...(tab?.index !== undefined ? { index: tab.index + 1 } : {})
        })
        return
      }
      const item = readPageActionMenuItems(state.items).find(item => item.id === action)
      if (!item || !pageMatchesCondition(item.when, href)) return
      const run: PageActionMenuRun = { onceCommand: "page-addon-action", action, contextId: state.contextId, href, title }
      await browserApi.runtime.sendMessage(run)
    })().catch(error => console.error("Could not run page action", error))
  })
}
