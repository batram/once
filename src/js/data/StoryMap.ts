import { ipcMain, ipcRenderer, webContents } from "electron"
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

export class StoryMap {
  static instance: StoryMap
  static remote = {
    async get(href: string): Promise<Story> {
      const story_obj = await ipcRenderer.invoke("inv_story_map", "get", href)
      if (story_obj) return Story.from_obj(story_obj)
    },
    async add(href: Story): Promise<Story> {
      return Story.from_obj(
        await ipcRenderer.invoke("inv_story_map", "add", href)
      )
    },
    stories_loaded(stories: Story[], bucket: string): void {
      const story_objs = stories.map((story) => {
        return story.to_obj()
      })
      ipcRenderer.send("story_map", "stories_loaded", story_objs, bucket)
    },
    persist_story_change(
      href: string,
      path: string,
      value: Story | string | boolean
    ): void {
      ipcRenderer.send("story_map", "persist_story_change", href, path, value)
    },
    async find_by_url(url: string): Promise<Story> {
      if (!url) {
        return
      }
      const story_obj = await ipcRenderer.invoke(
        "inv_story_map",
        "find_by_url",
        url
      )
      if (story_obj) return Story.from_obj(story_obj)
    },
  }

  subscribers: webContents[] = []

  constructor() {
    StoryMap.instance = this

    ipcMain.handle("inv_story_map", async (event, cmd, ...args: unknown[]) => {
      switch (cmd) {
        case "get":
          return this.get(args[0] as string)
        case "add":
          return this.add(Story.from_obj(args[0] as Record<string, unknown>))
        case "find_by_url":
          return this.find_by_url(args[0] as string)
        default:
          console.log("unhandled inv_story_map", cmd)
          event.returnValue = null
      }
    })

    ipcMain.on("story_map", async (event, cmd, ...args: unknown[]) => {
      switch (cmd) {
        case "subscribe_to_changes":
          if (!this.subscribers.includes(event.sender)) {
            this.subscribers.push(event.sender)
          }
          break
        case "persist_story_change":
          this.persist_story_change(
            args[0] as string,
            args[1] as string,
            args[2] as Story | string | boolean
          )
          event.returnValue = true
          break
        case "stories_loaded": {
          const stories = (args[0] as Record<string, unknown>[]).map(
            (st_obj: Record<string, unknown>) => {
              return Story.from_obj(st_obj)
            }
          )

          const mapped_stories = await this.add_stories(stories)

          this.get_all_stared().forEach((story) => {
            mapped_stories.push(story)
          })

          event.sender.send(
            "story_list",
            "add_stories",
            mapped_stories,
            args[1]
          )
          break
        }
        default:
          console.log("unhandled story_map", cmd)
          event.returnValue = null
      }
    })
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

  find_by_url(url: string): Story {
    console.debug("find_by_url", url)
    for (const i in this.internal_map) {
      if (typeof this.internal_map[i] != "function") {
        const story = this.internal_map[i]
        if (story.matches_url(url)) {
          return story
        }
      }
    }
  }

  emit_data_change(
    path: string[],
    value: unknown,
    previousValue: unknown,
    name: string
  ): void {
    if (path.length != 0) {
      if (this.has(path[0])) {
        //console.debug("fire DataChangeEvent", path, value, previousValue, name)
        const detail: DataChangeEventDetail = {
          story: this.get(path[0]),
          path: path,
          value: value,
          previousValue: previousValue,
          name: name,
          animated: OnceSettings.instance.animated,
        }
        this.subscribers.forEach((subscriber) => {
          if (!subscriber.isDestroyed()) {
            subscriber.send("story_map", "data_change", detail)
          }
        })
      }
    }
  }

  set(href: string, y: Story, quite = false): Story {
    const old_story = this.internal_map[href]
    this.internal_map[href] = y
    if (!quite) {
      this.emit_data_change([href], y, old_story, null)
    }
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

  async persist_story_change(
    href: string,
    path: string,
    value: Story | string | boolean
  ): Promise<Story> {
    let story = this.get(href)
    const previous_value = story[path]
    story[path] = value
    this.emit_data_change([href, path], value, previous_value, null)
    story = await OnceSettings.instance.save_story(story)
    return story
  }

  set_initial_stories(stories: Story[]): Story[] {
    return stories.map((story) => {
      return this.set(story.href, story, true)
    })
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

  async add(story: Story, bucket = "stories"): Promise<Story> {
    if (!(story instanceof Story)) {
      console.log("wrong StoryMap entry", story)
      throw "Please, only put stories in the StoryMap"
    }

    story.bucket = bucket

    let og_story = this.get(story.href)
    if (!og_story) {
      //new story
      story = this.set(story.href.toString(), story)
      story = await OnceSettings.instance.save_story(story)
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
          [og_story.href, "substories"],
          og_story.substories,
          prev_subs,
          null
        )
        og_story = await OnceSettings.instance.save_story(og_story)
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
                  story._attachments[i].data.length
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
          og_story = await OnceSettings.instance.save_story(og_story)
        }
      }

      story = og_story
    }

    return story
  }
}
