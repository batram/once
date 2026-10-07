import { requireClosestElement, requireElement } from "../dom"
import { openSettingsPage, registerSettingsOverview } from "./SettingsNavigation"

/** The pages of Settings › Sync; the overview links to the others. */
export type SyncPage = "overview" | "tabs" | "pair" | "addons"

/** Raised on a page's element each time it is shown, for content to bring itself up to date. */
export const SYNC_PAGE_SHOWN = "once:sync-page-shown"

/** Asks Settings › Sync to show one of its pages, from anywhere in the shell. */
export const SYNC_PAGE_EVENT = "once:sync-page"

/**
 * Settings › Sync as pages: the overview (connection, this device, links)
 * and one page each for Tab sync, Pair a device and Add-on sync. The header
 * Back steps from a page to the overview, as in Once Add-ons; every page
 * stays mounted, so drafts and listeners survive moving between them.
 */
export function bindSyncSettingsPages(root: HTMLElement, onShow: (page: SyncPage) => void = () => undefined): void {
  const pages = new Map([...root.querySelectorAll<HTMLElement>("[data-sync-page]")]
    .map((page) => [page.dataset.syncPage as SyncPage, page]))
  const header = requireClosestElement(root, "#settings_panel")
  const back = requireElement<HTMLButtonElement>("#settings_section_back", header)
  const title = requireElement<HTMLElement>(".settings_title", header)
  const active = () => root.closest(".settings_section")?.classList.contains("active") === true
  let current: SyncPage = "overview"
  let returnFocus: HTMLElement | null = null

  const setHeader = () => {
    if (!active()) return
    title.textContent = current === "overview" ? "Sync" : pages.get(current)?.dataset.syncTitle ?? "Sync"
  }
  const show = (target: SyncPage, focus = true) => openSettingsPage(root, {
    key: target,
    title: () => target === "overview" ? "Sync" : pages.get(target)?.dataset.syncTitle ?? "Sync",
    show: () => render(target, focus),
    valid: () => pages.has(target)
  })
  const render = (target: SyncPage, focus = true) => {
    if (!pages.has(target)) return
    if (current === "overview" && target !== "overview") {
      returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null
    }
    current = target
    for (const [key, page] of pages) page.hidden = key !== target
    setHeader()
    root.closest(".settings_section")?.scrollTo?.({ top: 0 })
    root.scrollTop = 0
    onShow(target)
    pages.get(target)?.dispatchEvent(new Event(SYNC_PAGE_SHOWN))
    if (!focus) return
    const link = root.querySelector<HTMLElement>(`[data-sync-target="${returnFocus?.dataset.syncTarget ?? ""}"]`)
    const destination = target === "overview" ? (link ?? returnFocus) : back
    destination?.focus({ preventScroll: true })
  }

  for (const link of root.querySelectorAll<HTMLButtonElement>("[data-sync-target]")) {
    link.addEventListener("click", () => show(link.dataset.syncTarget as SyncPage))
  }
  // Search results and deep links can point into a page that is not showing.
  root.addEventListener("once:settings-reveal", (event) => {
    const target = event.target instanceof HTMLElement ? event.target : null
    const page = target?.closest<HTMLElement>("[data-sync-page]")?.dataset.syncPage as SyncPage | undefined
    if (page && page !== current) show(page, false)
    const details = target?.closest("details")
    if (details) details.open = true
  })
  document.addEventListener(SYNC_PAGE_EVENT, (event) => show((event as CustomEvent<SyncPage>).detail))
  let wasActive = false
  new MutationObserver(() => {
    const isActive = active()
    if (isActive === wasActive) return
    wasActive = isActive
    if (isActive) setHeader()
  }).observe(header, { attributes: true, subtree: true, attributeFilter: ["class"] })
  registerSettingsOverview(root, () => render("overview", false))
  render("overview", false)
}
