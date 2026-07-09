import { Story } from "@once/core"
import { OnceSettings } from "../OnceSettings"
import { BackComms } from "@once/platform-webext"

export interface DataChangeEventDetail {
  story: Story
  path: string[] | string
  value: unknown
  previousValue: unknown
  name: string
  animated: boolean
}

export class StoryMap {
  static instance: StoryMap
  static remote = {
    async get(href: string): Promise<Story> {
      const story_obj = await BackComms.invoke("inv_story_map", "get", href)
      if (story_obj) return Story.from_obj(story_obj)
    },
    async add(href: Story): Promise<Story> {
      return Story.from_obj(
        await BackComms.invoke("inv_story_map", "add", href)
      )
    },
    stories_loaded(stories: Story[], bucket: string): void {
      const story_objs = stories.map((story) => {
        return story.to_obj()
      })
      BackComms.send("story_map", "stories_loaded", story_objs, bucket)
    },
    persist_story_change(
      href: string,
      path: string,
      value: Story | string | boolean
    ): void {
      BackComms.send("story_map", "persist_story_change", href, path, value)
    },
    async find_by_url(url: string): Promise<Story> {
      if (!url) {
        return
      }
      const story_obj = await BackComms.invoke(
        "inv_story_map",
        "find_by_url",
        url
      )
      if (story_obj) return Story.from_obj(story_obj)
    }
  }

  subscribers: number[] = []

  constructor() {
    StoryMap.instance = this

    BackComms.handlex("inv_story_map", async (event, cmd, ...args: any[]) => {
      switch (cmd) {
        case "get":
          return this.get(args[0] as string)
        case "add":
          return this.add(Story.from_obj(args[0] as Record<string, unknown>))
        case "find_by_url":
          return this.find_by_url(args[0][0] as string)
        default:
          console.log("unhandled inv_story_map", cmd)
          if (event) event.returnValue = null
      }
    })

    BackComms.on("story_map", async (event, cmd, ...args: unknown[]) => {
      switch (cmd) {
        case "persist_story_change":
          this.persist_story_change(
            args[0] as string,
            args[1] as string,
            args[2] as Story | string | boolean
          )
          if (event) event.returnValue = true
          break
        case "stories_loaded": {
          this.stories_loaded(args[0] as Story[], args[1] as string)
          break
        }
        default:
          console.log("unhandled story_map", cmd)
          if (event) event.returnValue = null
      }
    })
  }

  internal_map: Map<string, Story> = new Map()
  internal_map_ready = false
  comment_map: Map<string, string> = new Map()

  map(fun: (arg0: Story) => boolean): Story[] {
    const ar: Story[] = []
    this.internal_map.forEach((x) => {
      if (fun(x)) {
        ar.push(x)
      }
    })
    return ar
  }

  find_by_url(url: string): Story {
    console.debug("find_by_url", url)
    if (this.internal_map.has(url)) {
      return this.internal_map.get(url)
    } else if (this.comment_map.has(url)) {
      return this.internal_map.get(this.comment_map.get(url))
    }
    return null
  }

  emit_data_change(
    path: string[],
    value: unknown,
    previousValue: unknown,
    name: string
  ): void {
    if (path.length != 0) {
      if (this.has(path[0])) {
        const detail: DataChangeEventDetail = {
          story: this.get(path[0]),
          path: path,
          value: value,
          previousValue: previousValue,
          name: name,
          animated: OnceSettings.instance.animated
        }

        BackComms.send("story_map", "data_change", detail)
        this.subscribers.forEach((subscriber) => {
          console.log("subbedf==", subscriber)
        })
      }
    }
  }

  set(href: string, y: Story, quite = false): Story {
    const old_story = this.internal_map.get(href)
    this.internal_map.set(href, y)
    if (!quite) {
      this.emit_data_change([href], y, old_story, null)
    }
    this.comment_map.set(y.comment_url, y.href)
    y.substories.forEach((x) => {
      this.comment_map.set(x.comment_url, y.href)
    })

    return this.internal_map.get(href)
  }

  get(href: string): Story {
    return this.internal_map.get(href)
  }

  has(href: string): boolean {
    return this.internal_map.has(href)
  }

  async persist_story_change(
    href: string,
    path: string,
    value: Story | string | boolean
  ): Promise<Story> {
    let story = this.get(href)
    if (story) {
      const previous_value = story[path]
      story[path] = value
      this.emit_data_change([href, path], value, previous_value, null)
      story = await OnceSettings.instance.save_story(story)
    }
    return story
  }

  set_initial_stories(stories: Story[]): void {
    stories.map((story) => {
      return this.set(story.href, story, true)
    })
    this.internal_map_ready = true
  }

  async add_stories(stories: Story[]): Promise<Story[]> {
    const pomised_stories = Array.from(
      stories.map((story) => {
        return this.add(story)
      })
    )
    return Promise.all(pomised_stories)
  }

  get_all_stared(): Story[] {
    return this.map((story) => {
      return story.stared == true
    })
  }

  async stories_loaded(stories: Story[], bucket: string): Promise<void> {
    stories = (stories as Record<string, unknown>[]).map(
      (st_obj: Record<string, unknown>) => {
        return Story.from_obj(st_obj)
      }
    )

    const mapped_stories = await this.add_stories(stories)

    this.get_all_stared().forEach((story) => {
      mapped_stories.push(story)
    })

    BackComms.send("story_list", "add_stories", mapped_stories, bucket)
  }

  async add(new_story: Story, bucket = "stories"): Promise<Story> {
    if (!(new_story instanceof Story)) {
      console.log("wrong StoryMap entry", new_story)
      throw "Please, only put stories in the StoryMap"
    }

    new_story.bucket = bucket

    let og_story: Story

    if (this.internal_map_ready) {
      og_story = this.get(new_story.href)
    } else {
      og_story = await OnceSettings.instance.get_story(new_story.href)
    }

    if (!og_story) {
      //new story
      new_story = this.set(new_story.href.toString(), new_story)
      new_story = await OnceSettings.instance.save_story(new_story)

      return new_story
    }

    //tags
    if (
      new_story.comment_url == og_story.comment_url &&
      JSON.stringify(new_story.tags) != JSON.stringify(og_story.tags)
    ) {
      const prev_tags = og_story.tags
      new_story.tags.forEach((tag) => {
        if (!og_story.tags.map((t) => t.text).includes(tag.text)) {
          og_story.tags.push(tag)
        }
      })
      this.emit_data_change(
        [og_story.href, "tags"],
        og_story.tags,
        prev_tags,
        null
      )
      og_story = await OnceSettings.instance.save_story(og_story)
    }

    //comment urls
    const og_curls = og_story.substories.map((x) => {
      return x.comment_url
    })

    if (
      new_story.comment_url != og_story.comment_url &&
      !og_curls.includes(new_story.comment_url)
    ) {
      const prev_subs = og_story.substories
      //duplicate story
      og_story.substories.push({
        type: new_story.type,
        comment_url: new_story.comment_url,
        timestamp: new_story.timestamp,
        tags: new_story.tags
      })
      this.emit_data_change(
        [og_story.href, "substories"],
        og_story.substories,
        prev_subs,
        null
      )
      og_story = await OnceSettings.instance.save_story(og_story)
    }

    return og_story
  }
}
