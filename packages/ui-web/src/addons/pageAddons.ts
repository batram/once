import { AddonCondition, StoryView, URLRedirect, projectStoryView, sameStoryDocument } from "@once/core"
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

/**
 * How a shell runs one: `toggle` beside the page, `continue` on the
 * platform's larger surface (a tab), `panel` in the Once panel beside the page.
 */
export type PageActionMode = "toggle" | "continue" | "panel"

/** Where a page action's conversation opens, chosen per add-on in its settings. */
export type PageConversationPlace = "tab" | "panel"

/** An action as the shells list it: on a toolbar, in a page's context menu. */
export interface PageAddonAction {
  id: string
  label: string
  icon?: string
  surfaces: readonly PageActionSurface[]
  when?: AddonCondition
  /** The action needs the story list and search controls of a full panel. */
  requiresPanel?: boolean
  /** The action opens a tray's conversation, which can show in a tab or the panel. */
  converses?: boolean
  /** The tray this action opens; keeps multi-tool add-ons distinct. */
  tray?: string
  /** Set when the reader chose to see this add-on's page conversations in the Once panel. */
  place?: "panel"
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
let placementAvailable = false

export function setConversationPlacementAvailable(available: boolean): void { placementAvailable = available }
export function canChooseConversationPlacement(): boolean { return placementAvailable }

/** Reader wrappers keep the identity of their source article. */
export function pageSourceUrl(href: string): string {
  try {
    const url = new URL(href)
    if (url.protocol === "once-reader:" && ["http", "https"].includes(url.hostname)) return new URL(`${url.hostname}:${url.pathname}${url.search}${url.hash}`).href
    if (href.startsWith("about:reader?")) return url.searchParams.get("url") || href
  } catch { /* A loading or empty tab has no article identity. */ }
  return href
}

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
  return rows.find(row => sameStoryDocument(row.story.href, href)) ?? rows.find(row =>
    row.story.matches_comment_url?.(href) || sameStoryDocument(row.story.comment_url, href) || sameStoryDocument(row.dataset.redirected_url || URLRedirect.redirect_url(row.story.href), href))
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
  return shown.map(({ id, label, icon, surfaces, when, requiresPanel, converses, tray }) => ({ id, label, icon, surfaces,
    ...(tray ? { tray } : {}),
    ...(when ? { when } : {}), ...(requiresPanel ? { requiresPanel } : {}), ...(converses ? { converses } : {}),
    ...(converses && pageConversationPlace(addonOf(id)) === "panel" ? { place: "panel" as const } : {}) }))
}

/** Runs an action on a page. False when it is unknown, does not apply, or could not run. */
export function runPageAddonAction(id: string, page: AddonPage, how: PageActionMode): boolean {
  const action = actions.get(id)
  if (!action || !isAddonPage(page.href) || !action.appliesTo(page)) return false
  return action.run(page, how)
}

/** The add-on an action belongs to, from its `addon:<id>/<contribution>` id. */
function addonOf(actionId: string): string {
  return /^addon:([^/]+)\//.exec(actionId)?.[1] ?? ""
}

const placeKey = (addon: string) => `once:addon-conversation-place:${addon}`

/** Where this add-on's page conversations open on this device; a tab unless the reader chose the panel. */
export function pageConversationPlace(addon: string): PageConversationPlace {
  try { return localStorage.getItem(placeKey(addon)) === "panel" ? "panel" : "tab" } catch { return "tab" }
}

/** Remembered on this device; shells republish their page menus, which carry the choice. */
export function setPageConversationPlace(addon: string, place: PageConversationPlace): void {
  try {
    if (place === "panel") localStorage.setItem(placeKey(addon), "panel")
    else localStorage.removeItem(placeKey(addon))
  } catch { return }
  announce()
}

/** The mode a shell runs a page action in when the reader picks it from a page: their choice of tab or panel. */
export function pageRunMode(actionId: string): PageActionMode {
  return pageConversationPlace(addonOf(actionId)) === "panel" ? "panel" : "continue"
}

export function renderPageTrays(href: string, host: HTMLElement): void {
  host.replaceChildren()
  for (const render of trays.values()) {
    const element = render(href)
    if (element) host.append(element)
  }
}
