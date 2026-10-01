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
