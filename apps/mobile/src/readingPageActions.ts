import { isAddonPage, pageAddonActions, runPageAddonAction } from "@once/ui-web"
import { siteForUrl } from "@once/app/browsingSite"
import { runSendItem, sendPageItems } from "./tabSyncMenus"

const CLEAR_SITE = "once:clear-site-data"

/** The add-on tray actions the browser sheet offers for the page being read. */
export interface ReadingPageActions {
  list(): { id: string; label: string; placement?: "page"; holdsSheet?: boolean }[]
  /** Opens or closes the tray above the page; nothing when the page went away. Settles once a send is done. */
  run(id: string): void | Promise<void>
}

/**
 * For the reading session's page; only a web page gets actions: its add-on
 * trays, sending it to another device (the reading tab showing it, sent
 * with where it was left), and clearing what its site stored, where the
 * surface can (`clearSite` asks natively first).
 */
export function readingPageActions(
  reading: { session: { snapshot(): { currentUrl: string } }; tabs: { activeId: string | null } },
  clearSite?: (site: string) => Promise<unknown>
): ReadingPageActions {
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
      const site = clearSite ? siteForUrl(currentUrl()) : null
      const clear = site ? [{ id: CLEAR_SITE, label: `Clear data for ${site}`, placement: "page" as const }] : []
      return [...sendPageItems(currentUrl()), ...clear, ...trays]
    },
    run: id => {
      if (id === CLEAR_SITE) {
        const site = siteForUrl(currentUrl())
        return site && clearSite ? clearSite(site).then(() => undefined) : undefined
      }
      const sent = runSendItem(id, { url: currentUrl(), tabId: currentTab() ?? undefined })
      if (sent) return sent
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
