import {
  isAddonPage, pageAddonActions, renderPageTrays, runPageAddonAction, setPageTrayScope, STORY_TRAYS_CHANGED, StoryListItem
} from "@once/ui-web"
import type { ReadingTabs } from "./readingTabs"

/**
 * The trays above the reading surface: the current page's, open in the
 * selected tab. They share a story's conversation with its row in the list,
 * but each tab and the list open and close it on their own.
 */
export class ReadingAddonTrays {
  private readonly host = document.createElement("div")
  private story: StoryListItem | null = null
  private pageHref: string | null = null
  private tab: string | null | undefined

  constructor(content: HTMLElement, tabs: ReadingTabs, private readonly onVisibility: (open: boolean) => void) {
    this.host.id = "reading_addon_trays"
    this.host.className = "story"
    this.host.hidden = true
    this.host.setAttribute("aria-label", "Story addon trays")
    content.append(this.host)
    document.addEventListener(STORY_TRAYS_CHANGED, () => this.render())
    // Each reading tab opens and closes its own trays.
    this.setTab(tabs.activeId)
    tabs.subscribe(() => this.setTab(tabs.activeId))
  }

  setStory(story: StoryListItem | null): void {
    if (this.story === story) return
    this.story = story
    this.render()
  }

  /** The current page, including a listed story's redirected or comments URL. */
  setPage(href: string | null): void {
    if (this.pageHref === href) return
    this.pageHref = href
    this.render()
  }

  private setTab(id: string | null): void {
    if (this.tab === id) return
    this.tab = id
    setPageTrayScope(id ?? "")
    this.render()
  }

  /**
   * Opens or closes an action's tray above the page in this tab, for the
   * reading card's story menu: on the page as loaded, else on the story when
   * the page is not one the action takes. False when the action has no tray
   * or takes neither, which leaves it to the story's row.
   */
  toggle(id: string): boolean {
    if (![...pageAddonActions("menu"), ...pageAddonActions("button")].some(action => action.id === id && action.tray)) return false
    return [this.pageHref, this.story?.story.href].some(href => href && isAddonPage(href) && runPageAddonAction(id, { href }, "toggle"))
  }

  close(): boolean {
    if (this.host.hidden) return false
    for (const close of this.host.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]')) close.click()
    return true
  }

  private render(): void {
    if (this.pageHref) renderPageTrays(this.pageHref, this.host)
    else this.host.replaceChildren()
    // A redirected page can fail to name its row by URL, while the page was
    // still matched to this story; its trays are the story's.
    if (!this.host.childElementCount && this.story) renderPageTrays(this.story.story.href, this.host)
    this.host.hidden = this.host.childElementCount === 0
    this.onVisibility(!this.host.hidden)
  }
}
