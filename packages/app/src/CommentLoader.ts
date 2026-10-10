import { comments_provider_for } from "@once/collectors"
import type { CommentThread } from "@once/core"
import type { OncePlatformPorts } from "./types"

const TIMEOUT_MS = 20_000
const FRESH_MS = 5 * 60_000
const KEEP = 10

/**
 * Reads discussions through the collectors that know their sites, with the
 * shell's fetch. A few recent threads stay in memory so switching between the
 * page and the thread, or between two stories, does not refetch; nothing is
 * stored or synced, comments are always read fresh from the site.
 */
export class CommentLoader {
  private readonly recent = new Map<string, Promise<CommentThread>>()
  private readonly loadedAt = new Map<string, number>()

  constructor(private readonly fetch: typeof globalThis.fetch, private readonly now = () => Date.now()) {}

  canLoad(url: string): boolean {
    return /^https?:/i.test(url) && comments_provider_for(url) !== undefined
  }

  load(url: string, options: { refresh?: boolean } = {}): Promise<CommentThread> {
    const provider = comments_provider_for(url)
    if (!provider) return Promise.reject(new Error(`No collector reads comments at ${url}`))
    const cached = this.recent.get(url)
    const fresh = this.now() - (this.loadedAt.get(url) ?? 0) < FRESH_MS
    if (cached && fresh && !options.refresh) {
      this.remember(url, cached)
      return cached
    }
    const signal = AbortSignal.timeout(TIMEOUT_MS)
    const pending = provider.comments.load(url, { fetch: this.fetch, signal })
    this.remember(url, pending)
    this.loadedAt.set(url, this.now())
    // A failure is not kept: the next attempt asks again.
    pending.catch(() => {
      if (this.recent.get(url) === pending) this.forget(url)
    })
    return pending
  }

  private remember(url: string, thread: Promise<CommentThread>): void {
    this.recent.delete(url)
    this.recent.set(url, thread)
    for (const oldest of this.recent.keys()) {
      if (this.recent.size <= KEEP) break
      this.forget(oldest)
    }
  }

  private forget(url: string): void {
    this.recent.delete(url)
    this.loadedAt.delete(url)
  }
}

export function commentMethods(platform: Pick<OncePlatformPorts, "fetch">) {
  const loader = new CommentLoader(platform.fetch)
  return {
    canLoadComments: (url: string) => loader.canLoad(url),
    loadComments: (url: string, options?: { refresh?: boolean }) => loader.load(url, options)
  }
}
