import { Story } from "../data/Story"
import * as onChange from "on-change"
import * as story_list from "../view/StoryList"
import { StarList } from "../OnceSettings"

export interface DataChangeEventDetail {
  story: Story
  path: string[] | string
  value: unknown
  previousValue: unknown
  name: string
  animated: boolean
}

export class DataChangeEvent extends Event {
  detail: DataChangeEventDetail

  constructor(typeArg: string, detail: DataChangeEventDetail) {
    super(typeArg)
    this.detail = detail
  }
}

export class StoryMap {
  s_map = {}
  static instance: StoryMap

  constructor() {
    StoryMap.instance = this
  }

  forEach(fun: (arg0: Story) => unknown): void {
    for (const i in this.story_map) {
      if (typeof this.story_map[i] != "function") {
        fun(this.story_map[i])
      }
    }
  }

  story_map: Record<string, Story> = onChange(
    this.s_map,
    (path: string[], value: unknown, previousValue: unknown, name: string) => {
      console.debug("onChange data_change", path, value, previousValue, name)
      if (path.length != 0) {
        if (this.has(path[0])) {
          const event: DataChangeEvent = new DataChangeEvent("data_change", {
            story: this.get(path[0]),
            path: path,
            value: value,
            previousValue: previousValue,
            name: name,
            animated: document.body.getAttribute("animated") == "true",
          })
          const story_els = document.querySelectorAll(
            `.story[data-href="${path[0]}"]`
          )
          story_els.forEach((story_el) => {
            story_el.dispatchEvent(event)
          })
          document.body.dispatchEvent(event)
        }
      }
    },
    {
      pathAsArray: true,
    }
  )

  set(href: string, y: Story): Story {
    this.story_map[href] = y
    return this.story_map[href]
  }

  get(href: string): Story {
    return this.story_map[href]
  }

  has(href: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.story_map, href)
  }

  clear(): void {
    for (const i in this.story_map) {
      if (typeof this.story_map[i] != "function") {
        delete this.story_map[i]
      }
    }
  }

  persist_story_change(
    href: string,
    path: string,
    value: Story | string | boolean
  ): void {
    let story = this.get(href)
    if (path == "story" && value instanceof Story) {
      story = value
    } else {
      if (path == "read") {
        if (value) {
          story.add_to_readlist()
        } else {
          story.remove_from_readlist()
        }
      }
      if (path == "stared") {
        if (value) {
          story.add_to_starlist()
        } else {
          story.remove_from_starlist()
        }
      }
      story[path] = value
    }
  }

  add(story: Story, bucket = "stories"): Story {
    if (!(story instanceof Story)) {
      console.log("wrong StoryMap enty", story)
      throw "Please, only put stories in the StoryMap"
    }

    story.bucket = bucket

    const og_story = this.get(story.href)
    if (!og_story) {
      //new story
      story = this.set(story.href.toString(), story)
      story_list.add(story, bucket)
    } else {
      if (og_story.stared != story.stared) {
        story.update_stared()
      }
      if (og_story.read != story.read) {
        story.update_read()
      }

      //check if we already have as alternate source
      const curls = og_story.sources.map((x) => {
        return x.comment_url
      })

      if (!curls.includes(story.comment_url)) {
        //duplicate story
        og_story.sources.push({
          type: story.type,
          comment_url: story.comment_url,
          timestamp: story.timestamp,
        })
      }

      story = og_story
    }

    return story
  }

  restar(starlist: StarList): void {
    this.forEach((story: Story) => {
      story.stared = Object.prototype.hasOwnProperty.call(starlist, story.href)
    })

    this.add_stored_stars(starlist)
  }

  //TODO: specify starlist format
  add_stored_stars(starlist: StarList): void {
    for (const href in starlist) {
      const star_story = Story.from_obj(starlist[href])
      star_story.stared = true
      star_story.stored_star = true
      this.add(star_story)
    }
  }

  reread(readlist: string[]): void {
    this.forEach((story: Story) => {
      story.read = readlist.includes(story.href)
    })
  }
}
