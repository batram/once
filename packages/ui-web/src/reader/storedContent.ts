// Storing a page's article for a story: the manual action and the queue that
// serves the app's requests (bookmarked stories, sources asking for copies).
// The app decides which stories; this side has the DOM Readability needs.

import { OnceClient } from "@once/app"
import { extractArticle } from "./extractArticle"

/** Fetches the story's page, extracts the article, and stores it on the story. */
export async function saveStoryContentFromPage(
  client: OnceClient,
  href: string
): Promise<void> {
  const fetched = await client.fetchDocument(href)
  const article = extractArticle(fetched.html, fetched.url, fetched.mediaType)
  await client.saveStoryContent(href, article.content, {
    source: "page",
    title: article.title,
    byline: article.byline,
    site_name: article.siteName
  })
}

export interface StoredContentSaverOptions {
  /** How many pages are fetched at once; a reload can ask for hundreds. */
  concurrency?: number
  reportError?: (message: string, details: string) => void
  /** Injected so tests can drive the queue without the DOM. */
  save?: (client: OnceClient, href: string) => Promise<void>
}

/**
 * Serves `storyContentRequested`: one fetch per story, a few at a time, each
 * URL at most once while it is queued or running. A failure is reported once
 * and not retried; the next reload or bookmark asks again.
 */
export class StoredContentSaver {
  private readonly pending: string[] = []
  private readonly active = new Set<string>()
  private readonly queued = new Set<string>()
  private readonly concurrency: number
  private readonly reportError: (message: string, details: string) => void
  private readonly save: (client: OnceClient, href: string) => Promise<void>
  private settledResolvers: (() => void)[] = []

  constructor(
    private readonly client: OnceClient,
    options: StoredContentSaverOptions = {}
  ) {
    this.concurrency = options.concurrency ?? 2
    this.reportError = options.reportError ?? ((message, details) => {
      console.error(message, details)
    })
    this.save = options.save ?? saveStoryContentFromPage
  }

  request(href: string): void {
    if (this.queued.has(href) || this.active.has(href)) return
    this.queued.add(href)
    this.pending.push(href)
    this.pump()
  }

  /** Resolves once nothing is queued or running. */
  settled(): Promise<void> {
    if (this.pending.length === 0 && this.active.size === 0) return Promise.resolve()
    return new Promise((resolve) => this.settledResolvers.push(resolve))
  }

  private pump(): void {
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const href = this.pending.shift() as string
      this.queued.delete(href)
      this.active.add(href)
      void this.save(this.client, href)
        .catch((error) => {
          const detail = error instanceof Error ? error.message : String(error)
          this.reportError(
            `The article could not be saved for offline: ${detail}`,
            `Operation: story.content\nStory: ${href}\n\n${
              error instanceof Error ? error.stack || error.message : String(error)
            }`
          )
        })
        .finally(() => {
          this.active.delete(href)
          this.pump()
          if (this.pending.length === 0 && this.active.size === 0) {
            for (const resolve of this.settledResolvers.splice(0)) resolve()
          }
        })
    }
  }
}

export function installStoredContentSaver(
  client: OnceClient,
  options: StoredContentSaverOptions = {}
): StoredContentSaver {
  const saver = new StoredContentSaver(client, options)
  client.subscribe("storyContentRequested", ({ href }) => saver.request(href))
  return saver
}
