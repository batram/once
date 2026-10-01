import { AddonCondition, StoryView, URLRedirect, projectStoryView } from "@once/core"
import type { StoryListItem } from "../story/StoryListItem"

/**
 * A page the reader has open that need not be a story: the browser tab on
 * Electron, the page under the cursor in a browser extension, the reading
 * surface on mobile. Add-on actions run on it the way they run on a story.
 */
export interface AddonPage {
  href: string
  /** The page's title when the shell knows it; the href stands in otherwise. */
  title?: string
}

/** Where a shell shows a page action: its toolbar, or a page's menu. */
export type PageActionSurface = "button" | "menu"

/** How a shell runs one: `toggle` beside the page, `continue` on the platform's larger surface. */
export type PageActionMode = "toggle" | "continue"

/** An action as the shells list it: on a toolbar, in a page's context menu. */
export interface PageAddonAction {
  id: string
  label: string
  icon?: string
  surfaces: readonly PageActionSurface[]
  when?: AddonCondition
}

export interface RegisteredPageAction extends PageAddonAction {
  appliesTo(page: AddonPage): boolean
  /** False when the action could not run here, such as a tray with no larger surface. */
  run(page: AddonPage, how: PageActionMode): boolean
}

/** Raised on `document` whenever the set of page actions changes. */
export const PAGE_ADDON_ACTIONS_CHANGED = "once-page-addon-actions-changed"

const actions = new Map<string, RegisteredPageAction>()
const trays = new Map<string, (href: string) => HTMLElement | null>()

/** Only web pages get add-on actions: the shells' own pages and blank tabs do not. */
export function isAddonPage(href: string): boolean {
  return href.startsWith("http://") || href.startsWith("https://")
}

/** What an add-on sees of a page: the story shape, with the page as its own source. */
export function pageStoryView(page: AddonPage): StoryView {
  return projectStoryView({ href: page.href, title: page.title?.trim() || page.href, type: "page" })
}

/** Resolve page aliases the same way for tray actions and their reading host. */
export function pageStoryRow(href: string): StoryListItem | undefined {
  const rows = Array.from(document.querySelectorAll<StoryListItem>("story-item"))
  return rows.find(row => row.story.href === href) ?? rows.find(row =>
    row.story.comment_url === href || (row.dataset.redirected_url || URLRedirect.redirect_url(row.story.href)) === href)
}

function announce(): void {
  document.dispatchEvent(new Event(PAGE_ADDON_ACTIONS_CHANGED))
}

export function registerPageAction(action: RegisteredPageAction): () => void {
  actions.set(action.id, action)
  announce()
  return () => {
    if (actions.get(action.id) !== action) return
    actions.delete(action.id)
    announce()
  }
}

/** A tray's rendering for a page shown without a story row; the mobile reading surface draws these. */
export function registerPageTray(id: string, render: (href: string) => HTMLElement | null): () => void {
  trays.set(id, render)
  return () => { if (trays.get(id) === render) trays.delete(id) }
}

/**
 * The actions on offer for a surface; with a page, only those that apply to
 * it. The surface is the author's own declaration: an action kept off the
 * row's menu stays off the page's menu too.
 */
export function pageAddonActions(surface: PageActionSurface, page?: AddonPage): PageAddonAction[] {
  const list = [...actions.values()].filter(action => action.surfaces.includes(surface))
  const shown = page ? list.filter(action => isAddonPage(page.href) && action.appliesTo(page)) : list
  return shown.map(({ id, label, icon, surfaces, when }) => ({ id, label, icon, surfaces, ...(when ? { when } : {}) }))
}

/** Runs an action on a page. False when it is unknown, does not apply, or could not run. */
export function runPageAddonAction(id: string, page: AddonPage, how: PageActionMode): boolean {
  const action = actions.get(id)
  if (!action || !isAddonPage(page.href) || !action.appliesTo(page)) return false
  return action.run(page, how)
}

export function renderPageTrays(href: string, host: HTMLElement): void {
  host.replaceChildren()
  for (const render of trays.values()) {
    const element = render(href)
    if (element) host.append(element)
  }
}
