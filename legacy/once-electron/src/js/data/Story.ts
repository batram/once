import { OnceSettings } from "../OnceSettings"
import { URLRedirect } from "./URLRedirect"

export interface SubStory {
  type: string
  comment_url: string
  timestamp: string | number | Date
  tags?: StoryTag[]
}

export interface StoryTag {
  class: string
  text: string
  href?: string
  icon?: string
}

export interface SortableStory {
  read_state: "unread" | "read" | "skipped"
  timestamp: number | string | Date
  el?: HTMLElement
}

interface Attachment {
  [index: string]: {
    content_type: string
    data?: string
    raw_content?: string
    digest?: string
    length?: number
  }
}

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

  _attachments?: Attachment
  _rev?: string
  _id?: string;

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

  static from_obj(story: Record<string, unknown>): Story {
    const xstory = new Story()
    for (const i in story) {
      xstory[i] = story[i]
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
    //sort by read first and then timestamp
    const a_read = a.read_state != "unread"
    const b_read = b.read_state != "unread"

    if (a_read && !b_read) {
      return 1
    } else if (!a_read && b_read) {
      return -1
    } else if ((a_read && b_read) || (!a_read && !b_read)) {
      if (a.timestamp > b.timestamp) return -1
      if (a.timestamp < b.timestamp) return 1
      return 0
    }
    if (a.timestamp > b.timestamp) return -1
    if (a.timestamp < b.timestamp) return 1
    return 0
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

  has_content(): boolean {
    return (
      this._attachments &&
      this._attachments.content &&
      this._attachments.content.length != 0
    )
  }

  async get_content(): Promise<string> {
    if (this._attachments && this._attachments.content) {
      let body = null
      if (this._attachments.content.data) {
        body = atob(this._attachments.content.data)
      } else {
        let provider = null
        if (OnceSettings.instance) {
          provider = OnceSettings.instance.once_db
        } else {
          provider = OnceSettings.remote
        }
        if (provider) {
          const attachment = await provider.getAttachment(this._id, "content")
          if (attachment) {
            body = new TextDecoder("utf-8").decode(attachment as Buffer)
          }
        }
      }

      if (body) {
        const title = document.createElement("title")
        title.innerText = this.title
        const content = title.outerHTML + body
        return content
      }
    }
  }
}
