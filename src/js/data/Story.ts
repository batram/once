import * as onChange from "on-change"

export interface StorySource {
  type: string
  comment_url: string
  timestamp: string | number | Date
}

export interface SortableStory {
  read_state: "unread" | "read" | "skipped"
  timestamp: number | string | Date
  el?: HTMLElement
}

export class Story {
  type: string
  href: string
  title: string
  comment_url: string
  timestamp: string | number | Date
  filter: string
  sources: StorySource[]
  read: "unread" | "read" | "skipped"
  stared: boolean
  og_href: string;

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

    //TODO: class source or add complete stories as sources?
    this.sources = [
      {
        type: type,
        comment_url: comment_url,
        timestamp: timestamp,
      },
    ]
    this.comment_url = comment_url
    this.timestamp = timestamp
    this.filter = filter
  }

  static from_obj(story: Record<string, unknown>): Story {
    const xstory = new Story()
    for (const i in story) {
      xstory[i] = story[i]
    }
    if (!xstory.sources || xstory.sources.length == 0) {
      xstory.sources = [
        {
          type: xstory.type,
          comment_url: xstory.comment_url,
          timestamp: xstory.timestamp,
        },
      ]
    }
    return xstory
  }

  to_obj(): Record<string, unknown> {
    const cloned = JSON.parse(JSON.stringify(this))

    for (const i in this) {
      try {
        cloned[i] = onChange.target(this[i])
      } catch (e) {
        cloned[i] = null
      }
    }

    return cloned
  }

  clone(): Story {
    const cloned = new Story()
    for (const i in this) {
      try {
        cloned[i] = onChange.target(this)[i]
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
}
