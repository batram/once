import * as onChange from "on-change"
import * as settings from "../settings"

export interface StorySource {
  type: string
  comment_url: string
  timestamp: string | number | Date
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

  [index: string]: string | number | Date | {}[] | boolean | unknown

  constructor(
    type?: string,
    href?: string,
    title?: string,
    comment_url?: string,
    timestamp?: Date,
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

  static from_obj(story: any) {
    let xstory = new Story()
    for (let i in story) {
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

  to_obj() {
    let cloned = JSON.parse(JSON.stringify(this))

    for (let i in this) {
      try {
        cloned[i] = onChange.target(this[i])
      } catch (e) {
        cloned[i] = null
      }
    }

    return cloned
  }

  remove_from_readlist() {
    settings.get_readlist().then((readlist) => {
      const index = readlist.indexOf(this.href)
      if (index > -1) {
        readlist.splice(index, 1)
      }
      settings.save_readlist(readlist, console.log)
    })
  }

  add_to_readlist() {
    settings.get_readlist().then((readlist) => {
      let target_href = onChange.target(this).href
      if (!readlist.includes(target_href)) {
        readlist.push(target_href)
        readlist = readlist.filter(
          (href: string, i: number, a: any[]) => a.indexOf(href) === i
        )
        settings.save_readlist(readlist, console.log)
      }
    })
  }

  mark_as_read() {
    this.read = true
    this.add_to_readlist()
  }

  clone() {
    let cloned = new Story()
    for (let i in this) {
      try {
        cloned[i] = onChange.target(this)[i]
      } catch (e) {
        cloned[i] = null
      }
    }

    return cloned
  }

  star() {
    this.stared = true

    settings.get_starlist().then((starlist) => {
      starlist[this.href] = onChange.target(this)
      settings.save_starlist(starlist, console.log)
    })
  }

  unstar() {
    this.stared = false

    settings.get_starlist().then((starlist) => {
      if (starlist.hasOwnProperty(this.href)) {
        delete starlist[this.href]
        settings.save_starlist(starlist, console.log)
      }
    })
  }

  has_or_get(story_el: HTMLElement, prop: string, func: Function) {
    if (this.hasOwnProperty(prop)) {
      if (this[prop]) {
        story_el.classList.add(prop)
      }
      func(story_el, this)
    } else {
      if (typeof this["is_" + prop] == "function") {
        // @ts-ignore
        this["is_" + prop]().then((x: any) => {
          if (x) {
            story_el.classList.add(prop)
          }
          func(story_el, this)
        })
      }
    }
  }

  async update_read() {
    const readlist = await settings.get_readlist()
    this.read = readlist.includes(this.href)

    return this.read
  }

  async update_stared() {
    const starlist = await settings.get_starlist()
    this.stared = starlist.hasOwnProperty(this.href)

    return this.stared
  }

  static compare(
    a: { read: boolean; timestamp: number | string | Date },
    b: { read: boolean; timestamp: number | string | Date }
  ) {
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