import { OnceSettings } from "../OnceSettings"

export interface SubStory {
  type: string
  comment_url: string
  timestamp: string | number | Date
}

export interface SortableStory {
  read_state: "unread" | "read" | "skipped"
  timestamp: number | string | Date
  el?: HTMLElement
}

interface Attachment {
  [index: string]: {
    content_type: string
    data: Blob
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
  read: "unread" | "read" | "skipped"
  stared: boolean
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

  async get_content(): Promise<string> {
    if (this._attachments && this._attachments.content) {
      let body = null
      if (this._attachments.content.data) {
        body = await this._attachments.content.data.text()
      } else {
        if (OnceSettings.instance) {
          body = await ((await OnceSettings.instance.once_db.getAttachment(
            this._id,
            "content"
          )) as Blob).text()
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
