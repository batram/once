/** The panel's list of add-on actions for pages, sent whenever it changes. */
export interface PageActionMenuState {
  onceCommand: "page-actions-context"
  contextId: string
  items: { id: string; label: string }[]
}

/** The background's report of a chosen page action, for the page or a link in it. */
export interface PageActionMenuRun {
  onceCommand: "page-addon-action"
  action: string
  contextId: string
  href: string
  title: string
}

export function isPageActionRunForContext(
  message: { onceCommand?: string; contextId?: string },
  contextId: string
): message is PageActionMenuRun {
  return message.onceCommand === "page-addon-action" && message.contextId === contextId
}

const prefix = "once_page_"

/**
 * Offers the panel's add-on page actions in the context menu of every web
 * page and link. Items follow the panel's reports; the panel that reported
 * last is the one told about a click, so one window's panel acts on it.
 */
export function installPageActionMenuBackground(browserApi: typeof browser): void {
  const menus = browserApi.menus ?? browserApi.contextMenus
  if (!menus) {
    throw new Error("The WebExtension menus API is unavailable")
  }
  let contextId: string | undefined
  let known = new Map<string, string>()
  let applying: Promise<void> = Promise.resolve()

  const apply = async (items: PageActionMenuState["items"]): Promise<void> => {
    const next = new Map(items.map(item => [item.id, item.label]))
    for (const id of known.keys()) {
      if (!next.has(id)) await menus.remove(prefix + id).catch(() => undefined)
    }
    for (const [id, title] of next) {
      if (known.get(id) === title) continue
      // Chrome keeps items across worker restarts, so a fresh worker creates
      // over an item it never saw: remove first rather than trip on the id.
      await menus.remove(prefix + id).catch(() => undefined)
      menus.create({
        id: prefix + id,
        title,
        contexts: ["page", "link"],
        documentUrlPatterns: ["http://*/*", "https://*/*"]
      })
    }
    known = next
  }

  browserApi.runtime.onMessage.addListener((message: Partial<PageActionMenuState>) => {
    if (message.onceCommand !== "page-actions-context" || !message.contextId || !Array.isArray(message.items)) return
    contextId = message.contextId
    const items = message.items.filter(item => typeof item?.id === "string" && typeof item.label === "string")
    applying = applying.then(() => apply(items)).catch(error => console.error("Could not update page action menus", error))
  })

  menus.onClicked.addListener((info, tab) => {
    const id = String(info.menuItemId)
    if (!id.startsWith(prefix) || !contextId) return
    const href = info.linkUrl ?? info.pageUrl
    if (!href) return
    const linkText = (info as { linkText?: string }).linkText
    const run: PageActionMenuRun = {
      onceCommand: "page-addon-action",
      action: id.slice(prefix.length),
      contextId,
      href,
      title: info.linkUrl ? linkText ?? "" : tab?.title ?? ""
    }
    void browserApi.runtime.sendMessage(run).catch(() => undefined)
  })
}
