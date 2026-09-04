import { compareStories } from "./compareStories"
import {
  SortableStory,
  StoredContentMeta,
  StoryAttachment,
  StoryTag,
  SubStory
} from "./StoryTypes"

import { URLRedirect } from "./URLRedirect"

export class Story {
  type: string
  href: string
  title: string
  comment_url: string
  timestamp: string | number | Date
  filter: string
  substories: SubStory[]
  read_state: "unread" | "read" | "skipped"
  stared: boolean
  sync_updated_at?: Record<string, number>
  tags: StoryTag[]
  stored_content?: StoredContentMeta

  _attachments?: StoryAttachment
  _rev?: string
  _id?: string

  [index: string]:
    | string
    | number
    | Date
    | Record<string, unknown>[]
    | boolean
    | unknown

  constructor(
    type: string,
    href: string,
    title: string,
    comment_url = "",
    timestamp: string | number | Date = Date.now(),
    filter = ""
  ) {
    this.type = type
    this.href = href
    this.title = title
    this.read_state = "unread"
    this.comment_url = comment_url
    this.timestamp = timestamp
    this.filter = filter
    this.substories = []
    this.tags = []
    this.stared = false
    Story.assertIngestible(this)
  }

  static assertIngestible(
    story: Pick<Story, "type" | "href" | "title" | "timestamp">
  ): void {
    for (const field of ["type", "href", "title"] as const) {
      if (typeof story[field] !== "string" || !story[field].trim()) {
        throw new Error(`Story is missing required ${field}`)
      }
    }

    const timestamp =
      story.timestamp instanceof Date
        ? story.timestamp.getTime()
        : typeof story.timestamp === "number"
          ? story.timestamp
          : Date.parse(story.timestamp)
    if (!Number.isFinite(timestamp)) {
      throw new Error("Story has an invalid timestamp")
    }
  }

  static from_obj<T extends Story>(
    this: { prototype: T },
    story: Record<string, unknown>
  ): T {
    const xstory = Object.assign(
      Object.create(this.prototype) as T,
      {
        type: "",
        href: "",
        title: "",
        comment_url: "",
        timestamp: "",
        filter: "",
        read_state: "unread",
        substories: [],
        tags: [],
        stared: false
      },
      story
    )
    Story.assertIngestible(xstory)
    return xstory
  }

  to_obj(): Record<string, unknown> {
    const cloned = JSON.parse(JSON.stringify(this))

    for (const i in this) {
      try {
        cloned[i] = this[i]
      } catch (e) {
        cloned[i] = null
      }
    }

    return cloned
  }

  static compare(a: SortableStory, b: SortableStory): 1 | 0 | -1 {
    return compareStories(a, b)
  }

  matches_comment_url(url: string): boolean {
    return (
      this.comment_url === url ||
      (this.substories &&
        this.substories
          .map((x) => {
            return x.comment_url
          })
          .includes(url))
    )
  }
  matches_url(url: string): boolean {
    return this.matches_story_url(url) || this.matches_comment_url(url)
  }

  matches_story_url(url: string): boolean {
    const redirected_url = URLRedirect.redirect_url(this.href)
    return (
      this.href === url ||
      (redirected_url != this.href && redirected_url == url)
    )
  }

  /**
   * Hands the story its article html. It is written as the `content`
   * attachment by the story store on the next save; until then it rides
   * along as `raw_content`.
   */
  attachContent(html: string, meta: StoredContentMeta): void {
    this._attachments = {
      ...this._attachments,
      content: { content_type: "text/html", raw_content: html }
    }
    this.stored_content = meta
  }

  /** Html attached but not yet written, if any. */
  pendingContent(): string | undefined {
    return this._attachments?.content?.raw_content
  }

  /** Whether an article is stored (or about to be) for this story. */
  has_content(): boolean {
    const content = this._attachments?.content
    if (!content) return false
    if (typeof content.raw_content === "string") return content.raw_content.length > 0
    return typeof content.length === "number" && content.length > 0
  }

  contentSource(): StoredContentMeta["source"] | undefined {
    return this.has_content() ? this.stored_content?.source : undefined
  }
}
