import { isAddonPage, pageAddonActions, runPageAddonAction } from "@once/ui-web"
import { runSendItem, sendPageItems } from "./tabSyncMenus"

/** The add-on tray actions the browser sheet offers for the page being read. */
export interface ReadingPageActions {
  list(): { id: string; label: string; placement?: "page" }[]
  /** Opens or closes the tray above the page; nothing when the page went away. */
  run(id: string): void
}

/**
 * For the reading session's page; only a web page gets actions: its add-on
 * trays, and sending it to another device (the reading tab showing it, sent
 * with where it was left).
 */
export function readingPageActions(reading: { session: { snapshot(): { currentUrl: string } }; tabs: { activeId: string | null } }): ReadingPageActions {
  const currentUrl = () => reading.session.snapshot().currentUrl
  const currentTab = () => reading.tabs.activeId
  const page = () => {
    const href = currentUrl()
    return isAddonPage(href) ? { href } : null
  }
  return {
    list: () => {
      const current = page()
      const trays = current ? pageAddonActions("menu", current).map(({ id, label }) => ({ id, label })) : []
      return [...sendPageItems(currentUrl()), ...trays]
    },
    run: id => {
      if (runSendItem(id, { url: currentUrl(), tabId: currentTab() ?? undefined })) return
      const current = page()
      if (current) runPageAddonAction(id, current, "toggle")
    }
  }
}

/**
 * Add-on actions a long-press menu offers for a link: the same `menu`
 * actions desktop puts in its link menu, matched against the link.
 */
export function linkAddonItems(link: string | undefined, title?: string): { id: string; label: string }[] {
  if (!link || !isAddonPage(link)) return []
  return pageAddonActions("menu", { href: link, title }).map(({ id, label }) => ({ id, label }))
}
