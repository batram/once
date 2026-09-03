export interface NativeStoryMenuState {
  contextId: string
  items: {
    id: string
    label: string
    group: string
    enabled: boolean
    visible: boolean
  }[]
}

export interface NativeStoryMenuAction {
  onceCommand: "story-menu-action"
  action: string
  contextId: string
  targetElementId?: number
}

export function isStoryMenuActionForContext(
  message: { onceCommand?: string; contextId?: string },
  contextId: string
): message is NativeStoryMenuAction {
  return message.onceCommand === "story-menu-action" &&
    message.contextId === contextId
}

const prefix = "once_story_"
const defaults = [
  ["open", "Open story", "navigation"],
  ["open-comments", "Open comments", "navigation"],
  ["open-new-tab", "Open in new tab", "navigation"],
  ["open-background-tab", "Open in background tab", "navigation"],
  ["open-original", "Open original URL", "navigation"],
  ["open-reader", "Open in reader", "navigation"],
  ["toggle-read", "Skip reading", "state"],
  ["toggle-bookmark", "Bookmark", "state"],
  ["filter", "Filter source", "state"],
  ["search-domain", "Search this domain", "discovery"],
  ["copy-link", "Copy link address", "discovery"],
  ["copy-original-link", "Copy original link address", "discovery"],
  ["undo", "Undo", "history"],
  ["redo", "Redo", "history"],
  ["purge", "Purge story", "advanced"]
] as const

export function installStoryMenuBackground(browserApi: typeof browser): void {
  // Firefox exposes the extended API as browser.menus. Chromium and older
  // WebExtension environments use the contextMenus alias instead.
  const menus = browserApi.menus ?? browserApi.contextMenus
  if (!menus) {
    throw new Error("The WebExtension menus API is unavailable")
  }
  const pagePattern = browserApi.runtime.getURL("/static/sidepanel.html") + "*"
  let menuContextId: string | undefined
  // Menu items exist for the built-in actions from install time; add-on
  // actions arrive with the panel's state and get their item on first sight.
  const created = new Set<string>()
  const createItem = (id: string, title: string): void => {
    created.add(id)
    menus.create({
      id: prefix + id,
      title,
      contexts: ["all"],
      documentUrlPatterns: [pagePattern],
      visible: false
    })
  }

  const createMenus = async (): Promise<void> => {
    await menus.removeAll()
    created.clear()
    let group = ""
    for (const [id, title, nextGroup] of defaults) {
      if (group && group !== nextGroup) {
        menus.create({
          id: `${prefix}separator_${nextGroup}`,
          type: "separator",
          contexts: ["all"],
          documentUrlPatterns: [pagePattern],
          visible: false
        })
      }
      group = nextGroup
      createItem(id, title)
    }
  }

  browserApi.runtime.onInstalled.addListener(() => {
    void createMenus()
  })

  browserApi.runtime.onMessage.addListener((message: {
    onceCommand?: string
    contextId?: string
    items?: NativeStoryMenuState["items"]
  }) => {
    if (
      message.onceCommand !== "story-menu-context" ||
      !message.contextId ||
      !message.items
    ) return
    menuContextId = message.contextId
    const items = message.items
    void (async () => {
      const state = new Map(items.map((item) => [item.id, item]))
      const updates: Promise<void>[] = []
      for (const item of items) {
        if (!created.has(item.id)) createItem(item.id, item.label)
      }
      for (const id of created) {
        const item = state.get(id)
        updates.push(menus.update(prefix + id, {
          title: item?.label ?? defaults.find(([known]) => known === id)?.[1] ?? id,
          enabled: item?.enabled ?? false,
          visible: item?.visible ?? false
        }))
      }
      const groupOrder = ["navigation", "state", "discovery", "history", "advanced"]
      const visibleGroups = new Set(
        items.filter((item) => item.visible).map((item) => item.group)
      )
      let earlierGroupVisible = false
      for (const group of groupOrder) {
        const groupVisible = visibleGroups.has(group)
        if (group !== "navigation") {
          updates.push(menus.update(`${prefix}separator_${group}`, {
            visible: groupVisible && earlierGroupVisible
          }))
        }
        earlierGroupVisible ||= groupVisible
      }
      await Promise.all(updates)
      const refresh =
        (menus as unknown as { refresh?: () => Promise<void> }).refresh
      if (refresh) await refresh.call(menus)
    })()
  })

  menus.onClicked.addListener((info) => {
    const id = String(info.menuItemId)
    if (
      !id.startsWith(prefix) ||
      id.includes("separator_") ||
      !menuContextId
    ) return
    void browserApi.runtime.sendMessage({
      onceCommand: "story-menu-action",
      action: id.slice(prefix.length),
      contextId: menuContextId,
      targetElementId: info.targetElementId
    })
  })
}
