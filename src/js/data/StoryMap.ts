import { Story } from "../data/Story"
import * as onChange from "on-change"
import { OnceSettings } from "../OnceSettings"

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

  map(fun: (arg0: Story) => boolean): Story[] {
    const ar = []
    for (const i in this.story_map) {
      if (typeof this.story_map[i] != "function") {
        if (fun(this.story_map[i])) {
          ar.push(this.story_map[i])
        }
      }
    }
    return ar
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
      ignoreUnderscores: true,
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
      story[path] = value
      OnceSettings.instance.save_story(story).then((resp) => {
        if (resp && (resp as PouchDB.Core.Response).rev) {
          story._rev = resp.rev
        }
      })
    }
  }

  stored_add(stories: Story[]): void {
    console.debug("add intial stories", stories)
    stories.forEach((story) => {
      this.set(story.href.toString(), story)
    })
  }

  get_all_stared(): Story[] {
    return this.map((story) => {
      return story.stared == true
    })
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
      OnceSettings.instance.save_story(story)
    } else {
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
        OnceSettings.instance.save_story(og_story)
      }

      story = og_story
    }

    return story
  }
}
