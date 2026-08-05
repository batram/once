/**
 * Runs one reader extraction. The delivery callback is handed in so a document
 * whose tab has moved on can be dropped instead of installed.
 */
export type ReaderRequestRunner = (
  url: string,
  deliver: (html: string, sourceUrl: string) => Promise<void>
) => Promise<void>

export interface ReaderRequestHost {
  /** True while the tab is still open in this window. */
  hasTab(tabId: string): boolean
  deliver(tabId: string, html: string, sourceUrl: string): Promise<void>
  fail(tabId: string, url: string, error: unknown): void
  /** Called whenever the set of pending requests changed. */
  changed(): void
}

interface PendingRequest {
  id: number
  url: string
}

/**
 * Reader requests in flight, one per tab. Fetching and extracting an article
 * takes as long as loading the page does, and the tab stays usable meanwhile,
 * so each request is tied to the tab that asked for it: only the newest request
 * per tab may deliver, and a tab the user has since steered elsewhere or closed
 * drops its result rather than replacing what is now on screen.
 */
export class ReaderRequests {
  private readonly pending = new Map<string, PendingRequest>()
  private count = 0

  constructor(
    private readonly run: ReaderRequestRunner,
    private readonly host: ReaderRequestHost
  ) {}

  isPending(tabId: string): boolean {
    return this.pending.has(tabId)
  }

  start(tabId: string, url: string): void {
    if (this.pending.get(tabId)?.url === url) return
    const id = (this.count += 1)
    this.pending.set(tabId, { id, url })
    this.host.changed()
    void this.run(url, async (html, sourceUrl) => {
      if (!this.owns(tabId, id)) return
      await this.host.deliver(tabId, html, sourceUrl)
    })
      .then(() => this.settle(tabId, id))
      .catch((error) => {
        if (!this.settle(tabId, id)) return
        this.host.fail(tabId, url, error)
      })
  }

  cancel(tabId: string): void {
    if (this.pending.delete(tabId)) this.host.changed()
  }

  /** Forgets requests whose tab has gone; closed tabs never deliver. */
  retainTabs(tabIds: Iterable<string>): void {
    const open = new Set(tabIds)
    for (const tabId of [...this.pending.keys()]) {
      if (!open.has(tabId)) this.pending.delete(tabId)
    }
  }

  private owns(tabId: string, id: number): boolean {
    return this.pending.get(tabId)?.id === id && this.host.hasTab(tabId)
  }

  /** Returns false when a newer request, or none, owns the tab by now. */
  private settle(tabId: string, id: number): boolean {
    if (this.pending.get(tabId)?.id !== id) return false
    this.pending.delete(tabId)
    this.host.changed()
    return this.host.hasTab(tabId)
  }
}
