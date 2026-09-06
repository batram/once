import { renderStoryTrays, STORY_TRAYS_CHANGED, StoryListItem } from "@once/ui-web"

/** A second view of the current story's tray state, above its reading surface. */
export class ReadingAddonTrays {
  private readonly host = document.createElement("div")
  private story: StoryListItem | null = null

  constructor(content: HTMLElement, private readonly onVisibility: (open: boolean) => void) {
    this.host.id = "reading_addon_trays"
    this.host.className = "story"
    this.host.hidden = true
    this.host.setAttribute("aria-label", "Story addon trays")
    content.append(this.host)
    document.addEventListener(STORY_TRAYS_CHANGED, event => {
      const href = (event as CustomEvent<string>).detail
      if (!href || href === this.story?.story.href) this.render()
    })
  }

  setStory(story: StoryListItem | null): void {
    if (this.story === story) return
    this.story = story
    this.render()
  }

  close(): boolean {
    if (this.host.hidden) return false
    for (const close of this.host.querySelectorAll<HTMLButtonElement>('button[aria-label="Close"]')) close.click()
    return true
  }

  private render(): void {
    if (this.story) renderStoryTrays(this.story, this.host)
    else this.host.replaceChildren()
    this.host.hidden = this.host.childElementCount === 0
    this.onVisibility(!this.host.hidden)
  }
}
