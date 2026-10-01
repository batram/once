import { renderPageTrays, renderStoryTrays, STORY_TRAYS_CHANGED, StoryListItem } from "@once/ui-web"

/**
 * A second view of the current story's tray state, above its reading surface.
 * A page that is no listed story gets its own trays here instead, opened from
 * the browser sheet.
 */
export class ReadingAddonTrays {
  private readonly host = document.createElement("div")
  private story: StoryListItem | null = null
  private pageHref: string | null = null

  constructor(content: HTMLElement, private readonly onVisibility: (open: boolean) => void) {
    this.host.id = "reading_addon_trays"
    this.host.className = "story"
    this.host.hidden = true
    this.host.setAttribute("aria-label", "Story addon trays")
    content.append(this.host)
    document.addEventListener(STORY_TRAYS_CHANGED, () => this.render())
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

  close(): boolean {
    if (this.host.hidden) return false
    // Closing a page tray may reveal the same conversation opened on its row.
    // Dismiss both places when leaving the overlay with Back.
    for (let pass = 0; pass < 2; pass++) {
      for (const close of this.host.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]')) close.click()
    }
    return true
  }

  private render(): void {
    if (this.pageHref) renderPageTrays(this.pageHref, this.host)
    else if (this.story) renderStoryTrays(this.story, this.host)
    else this.host.replaceChildren()
    this.host.hidden = this.host.childElementCount === 0
    this.onVisibility(!this.host.hidden)
  }
}
