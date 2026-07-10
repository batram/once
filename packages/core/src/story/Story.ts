import { compareStories } from "./compareStories"
import { SortableStory, StoryAttachment, StoryTag, SubStory } from "./StoryTypes"

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
  tags: StoryTag[]

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
    type?: string,
    href?: string,
    title?: string,
    comment_url?: string,
    timestamp?: string | number | Date,
    filter?: string
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
  }

  static from_obj<T extends Story>(
    this: new () => T,
    story: Record<string, unknown>
  ): T {
    const xstory = new this()
    for (const i in story) {
      (xstory as Record<string, unknown>)[i] = story[i]
    }
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
    //todo: fix redirect lookup
    const redirected_url = URLRedirect.redirect_url(this.href)
    return (
      this.href === url ||
      (redirected_url != this.href && redirected_url == url)
    )
  }

  async get_content(): Promise<string | undefined> {
    if (this._attachments && this._attachments.content) {
      let body: string | undefined
      if (this._attachments.content.data) {
        body = atob(this._attachments.content.data)
      }

      if (body) {
        const title = this.title
          .replace(/&/g, "&amp;")
          .replace(/</g, "&lt;")
          .replace(/>/g, "&gt;")
        const content = `<title>${title}</title>${body}`
        return content
      }
    }
    return undefined
  }

  has_content(): boolean {
    return (
      this._attachments &&
      this._attachments.content &&
      this._attachments.content.length != 0
    )
  }
}
