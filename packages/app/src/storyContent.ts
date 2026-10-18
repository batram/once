// Stored articles from the app's side: reading one back, storing one the UI
// extracted, and deciding whether feed text should replace what a story holds.

import { StoredContentMeta, Story } from "@once/core"
import { DiagnosticError, StoryStorePort } from "./types"

export interface StoryContentHost {
  findStoryByUrl(url: string): Promise<Story | null>
  workingStory(href: string): Story | undefined
  queueStoryWrite<T>(
    href: string,
    task: () => Promise<T>,
    failure: Pick<DiagnosticError, "operation" | "message">
  ): Promise<T>
  emitDataChange(
    path: string[],
    value: unknown,
    previousValue: unknown
  ): void
}

export class StoryContentService {
  constructor(
    private readonly store: StoryStorePort,
    private readonly host: StoryContentHost
  ) {}

  async get(href: string): Promise<{ html: string; meta: StoredContentMeta } | null> {
    const story = await this.host.findStoryByUrl(href)
    if (!story?.has_content()) return null
    const html = story.pendingContent() ?? await this.store.getStoryContent(story.href)
    if (html == null) return null
    return { html, meta: story.stored_content ?? { source: "feed", saved_at: 0 } }
  }

  /** Attaches the article, announces it, and writes it in the story's queue. */
  async save(
    href: string,
    html: string,
    meta: Omit<StoredContentMeta, "saved_at"> & { saved_at?: number }
  ): Promise<Story | undefined> {
    const story = await this.host.findStoryByUrl(href)
    if (!story) return undefined
    const previousMeta = story.stored_content
    story.attachContent(html, { ...meta, saved_at: meta.saved_at ?? Date.now() })
    this.host.emitDataChange([story.href, "stored_content"], story.stored_content, previousMeta)
    return this.host.queueStoryWrite(story.href, async () => {
      const saved = await this.store.saveStory(story)
      const current = this.host.workingStory(story.href)
      if (current && current !== saved) {
        current._id = saved._id
        current._rev = saved._rev
        current._attachments = saved._attachments
        current.stored_content = saved.stored_content
      }
      return current ?? saved
    }, {
      operation: "story.content",
      message: "The story's article could not be stored"
    })
  }

  /**
   * Feed text fills a story that has none and follows a feed's edits, but
   * never replaces an article extracted from the page itself. Returns the
   * saved story when something was written.
   */
  async mergeFeedContent(stored: Story, incoming: Story): Promise<Story | null> {
    const html = incoming.pendingContent()
    if (html === undefined || stored.contentSource() === "page") return null
    if (stored.has_content() && await this.store.getStoryContent(stored.href) === html) return null
    const previousMeta = stored.stored_content
    // The collector's meta, not the clock: devices merging the same feed
    // text must write the same revision.
    stored.attachContent(html, incoming.stored_content ?? { source: "feed", saved_at: 0 })
    const saved = await this.store.saveStory(stored)
    this.host.emitDataChange([saved.href, "stored_content"], saved.stored_content, previousMeta)
    return saved
  }
}
