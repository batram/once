import { StoryView } from "@once/core"
import type { StoryListItem } from "../story/StoryListItem"
import type { AddonSandbox } from "./AddonSandbox"

interface Waiting {
  row: StoryListItem
  element: HTMLElement
}

/**
 * Computed badges are asked for in batches: rows that appear in the same
 * tick go to the sandbox as one `badges` request per contribution, and each
 * answer fills its element or removes it when empty. A row that left the
 * document before the answer came is simply skipped.
 */
export class BadgeScheduler {
  private readonly waiting = new Map<string, Waiting[]>()
  private scheduled = false

  constructor(
    private readonly sandbox: AddonSandbox,
    private readonly viewOf: (row: StoryListItem) => StoryView
  ) {}

  request(contribution: string, row: StoryListItem, element: HTMLElement): void {
    const list = this.waiting.get(contribution) ?? []
    list.push({ row, element })
    this.waiting.set(contribution, list)
    element.dataset.addonBadge = contribution
    if (this.scheduled) return
    this.scheduled = true
    setTimeout(() => void this.flush(), 30)
  }

  /** Fills a badge element the add-on named, from `updateBadge`. */
  static show(row: StoryListItem | undefined, contribution: string, text: string): void {
    const element = row?.querySelector<HTMLElement>(`[data-addon-badge="${CSS.escape(contribution)}"]`)
    if (!element) return
    delete element.dataset.addonPending
    element.textContent = text
    element.hidden = text.trim() === ""
  }

  private async flush(): Promise<void> {
    this.scheduled = false
    const batches = [...this.waiting.entries()]
    this.waiting.clear()
    for (const [contribution, entries] of batches) {
      const live = entries.filter((entry) => entry.element.isConnected)
      if (live.length === 0) continue
      try {
        const session = await this.sandbox.ensure()
        const texts = await session.badges(contribution, live.map((entry) => this.viewOf(entry.row)))
        live.forEach((entry, index) => {
          delete entry.element.dataset.addonPending
          entry.element.textContent = texts[index]
          entry.element.hidden = texts[index].trim() === ""
        })
      } catch {
        for (const entry of live) entry.element.remove()
      }
    }
  }
}
