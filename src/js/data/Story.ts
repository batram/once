import * as onChange from "on-change"
import { OnceSettings } from "../OnceSettings"

export interface StorySource {
  type: string
  comment_url: string
  timestamp: string | number | Date
}

export interface SortableStory {
  read: boolean
  timestamp: number | string | Date
}

export class Story {
  type: string
  href: string
  title: string
  comment_url: string
  timestamp: string | number | Date
  filter: string
  sources: StorySource[]
  read: boolean
  stared: boolean
  stored_star: boolean
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

  remove_from_readlist(): void {
    OnceSettings.instance.get_readlist().then((readlist) => {
      const index = readlist.indexOf(this.href)
      if (index > -1) {
        readlist.splice(index, 1)
      }
      OnceSettings.instance.save_readlist(readlist, console.log)
    })
  }

  add_to_readlist(): void {
    OnceSettings.instance.get_readlist().then((readlist) => {
      const target_href = onChange.target(this).href
      if (!readlist.includes(target_href)) {
        readlist.push(target_href)
        readlist = readlist.filter(
          (href: string, i: number, a: string[]) => a.indexOf(href) === i
        )
        OnceSettings.instance.save_readlist(readlist, console.log)
      }
    })
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

  add_to_starlist(): void {
    OnceSettings.instance.get_starlist().then((starlist) => {
      starlist[this.href] = onChange.target(this)
      OnceSettings.instance.save_starlist(starlist, console.log)
    })
  }

  remove_from_starlist(): void {
    OnceSettings.instance.get_starlist().then((starlist) => {
      if (Object.prototype.hasOwnProperty.call(starlist, this.href)) {
        delete starlist[this.href]
        OnceSettings.instance.save_starlist(starlist, console.log)
      }
    })
  }

  async update_read(): Promise<boolean> {
    const readlist = await OnceSettings.instance.get_readlist()
    this.read = readlist.includes(this.href)

    return this.read
  }

  async update_stared(): Promise<boolean> {
    const starlist = await OnceSettings.instance.get_starlist()
    this.stared = Object.prototype.hasOwnProperty.call(starlist, this.href)

    return this.stared
  }

  static compare(a: SortableStory, b: SortableStory): 1 | 0 | -1 {
    //sort by read first and then timestamp
    if (a.read && !b.read) {
      return 1
    } else if (!a.read && b.read) {
      return -1
    } else if ((a.read && b.read) || (!a.read && !b.read)) {
      if (a.timestamp > b.timestamp) return -1
      if (a.timestamp < b.timestamp) return 1
      return 0
    }
    if (a.timestamp > b.timestamp) return -1
    if (a.timestamp < b.timestamp) return 1
    return 0
  }
}
