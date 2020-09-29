import { Story } from "../data/Story"
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
  static instance: StoryMap

  constructor() {
    StoryMap.instance = this
  }

  internal_map: Record<string, Story> = {}

  forEach(fun: (arg0: Story) => unknown): void {
    for (const i in this.internal_map) {
      if (typeof this.internal_map[i] != "function") {
        fun(this.internal_map[i])
      }
    }
  }

  map(fun: (arg0: Story) => boolean): Story[] {
    const ar = []
    for (const i in this.internal_map) {
      if (typeof this.internal_map[i] != "function") {
        if (fun(this.internal_map[i])) {
          ar.push(this.internal_map[i])
        }
      }
    }
    return ar
  }

  emit_data_change(
    path: string[],
    value: unknown,
    previousValue: unknown,
    name: string
  ): void {
    if (path.length != 0) {
      if (this.has(path[0])) {
        console.debug("fire DataChangeEvent", path, value, previousValue, name)
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
  }

  set(href: string, y: Story): Story {
    const old_story = this.internal_map[href]
    this.internal_map[href] = y
    this.emit_data_change([href], y, old_story, null)
    return this.internal_map[href]
  }

  get(href: string): Story {
    return this.internal_map[href]
  }

  has(href: string): boolean {
    return Object.prototype.hasOwnProperty.call(this.internal_map, href)
  }

  clear(): void {
    for (const i in this.internal_map) {
      if (typeof this.internal_map[i] != "function") {
        delete this.internal_map[i]
      }
    }
  }

  persist_story_change(
    href: string,
    path: string,
    value: Story | string | boolean
  ): void {
    const story = this.get(href)
    const previous_value = story[path]
    story[path] = value
    this.emit_data_change([href, path], value, previous_value, null)
    OnceSettings.instance.save_story(story).then((resp) => {
      if (resp && (resp as PouchDB.Core.Response).rev) {
        story._rev = resp.rev
      }
    })
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
      const curls = og_story.substories.map((x) => {
        return x.comment_url
      })

      if (
        story.comment_url != og_story.comment_url &&
        !curls.includes(story.comment_url)
      ) {
        const prev_subs = og_story.substories
        //duplicate story
        og_story.substories.push({
          type: story.type,
          comment_url: story.comment_url,
          timestamp: story.timestamp,
        })
        this.emit_data_change(
          [story.href, "substories"],
          og_story.substories,
          prev_subs,
          null
        )
        OnceSettings.instance.save_story(og_story)
      }

      if (story._attachments) {
        const prev_attached = og_story._attachments
        if (!og_story._attachments) {
          og_story._attachments = story._attachments
        } else {
          for (const i in story._attachments) {
            if (story._attachments[i].data) {
              if (og_story._attachments[i]) {
                //TODO: compare md5
                if (
                  og_story._attachments[i].length !=
                  story._attachments[i].data.size
                ) {
                  og_story._attachments[i] = story._attachments[i]
                }
              } else {
                og_story._attachments[i] = story._attachments[i]
              }
            }
          }
        }
        if (prev_attached != og_story._attachments) {
          this.emit_data_change(
            [story.href, "_attachments"],
            og_story._attachments,
            prev_attached,
            null
          )
          OnceSettings.instance.save_story(og_story)
        }
      }

      story = og_story
    }

    return story
  }
}
