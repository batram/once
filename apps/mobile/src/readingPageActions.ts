import { isAddonPage, pageAddonActions, runPageAddonAction } from "@once/ui-web"

/** The add-on tray actions the browser sheet offers for the page being read. */
export interface ReadingPageActions {
  list(): { id: string; label: string }[]
  /** Opens or closes the tray above the page; nothing when the page went away. */
  run(id: string): void
}

/** `currentUrl` is the reading session's page; only a web page gets actions. */
export function readingPageActions(currentUrl: () => string): ReadingPageActions {
  const page = () => {
    const href = currentUrl()
    return isAddonPage(href) ? { href } : null
  }
  return {
    list: () => {
      const current = page()
      return current ? pageAddonActions("menu", current).map(({ id, label }) => ({ id, label })) : []
    },
    run: id => {
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
