import { Story } from "./Story"

export interface DataChangeEventDetail {
  story: Story
  path: string[] | string
  value: unknown
  previousValue: unknown
  name: string
  animated: boolean
}

export interface StoryMapOptions {
  animated?: () => boolean
  getStoredStory?: (href: string) => Promise<Story>
  saveStory?: (story: Story) => Promise<Story>
  onDataChange?: (detail: DataChangeEventDetail) => void
  onStoriesChanged?: (stories: Story[], bucket: string) => void
}

export class StoryMap {
  static instance: StoryMap
  subscribers: number[] = []
  internal_map: Map<string, Story> = new Map()
  internal_map_ready = false
  comment_map: Map<string, string> = new Map()

  constructor(private options: StoryMapOptions = {}) {
    StoryMap.instance = this
  }

  configure(options: StoryMapOptions): void {
    this.options = { ...this.options, ...options }
  }

  map(fun: (arg0: Story) => boolean): Story[] {
    const stories: Story[] = []
    this.internal_map.forEach((story) => {
      if (fun(story)) {
        stories.push(story)
      }
    })
    return stories
  }

  find_by_url(url: string): Story {
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
    if (path.length != 0 && this.has(path[0])) {
      const detail: DataChangeEventDetail = {
        story: this.get(path[0]),
        path,
        value,
        previousValue,
        name,
        animated: this.options.animated?.() ?? true
      }

      this.options.onDataChange?.(detail)
    }
  }

  set(href: string, story: Story, quiet = false): Story {
    const oldStory = this.internal_map.get(href)
    this.internal_map.set(href, story)
    if (!quiet) {
      this.emit_data_change([href], story, oldStory, null)
    }
    this.comment_map.set(story.comment_url, story.href)
    story.substories.forEach((substory) => {
      this.comment_map.set(substory.comment_url, story.href)
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
      const previousValue = story[path]
      story[path] = value
      this.emit_data_change([href, path], value, previousValue, null)
      story = await this.options.saveStory?.(story)
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
    return Promise.all(stories.map((story) => this.add(story)))
  }

  get_all_stared(): Story[] {
    return this.map((story) => {
      return story.stared == true
    })
  }

  async stories_loaded(stories: Story[], bucket: string): Promise<void> {
    stories = (stories as Record<string, unknown>[]).map(
      (storyObject: Record<string, unknown>) => {
        return Story.from_obj(storyObject)
      }
    )

    const mappedStories = await this.add_stories(stories)

    this.get_all_stared().forEach((story) => {
      mappedStories.push(story)
    })

    this.options.onStoriesChanged?.(mappedStories, bucket)
  }

  async add(newStory: Story, bucket = "stories"): Promise<Story> {
    if (!(newStory instanceof Story)) {
      throw new Error("Please, only put stories in the StoryMap")
    }

    newStory.bucket = bucket

    let oldStory: Story

    if (this.internal_map_ready) {
      oldStory = this.get(newStory.href)
    } else {
      oldStory = await this.options.getStoredStory?.(newStory.href)
    }

    if (!oldStory) {
      newStory = this.set(newStory.href.toString(), newStory)
      newStory = (await this.options.saveStory?.(newStory)) || newStory

      return newStory
    }

    if (
      newStory.comment_url == oldStory.comment_url &&
      JSON.stringify(newStory.tags) != JSON.stringify(oldStory.tags)
    ) {
      const previousTags = oldStory.tags
      newStory.tags.forEach((tag) => {
        if (!oldStory.tags.map((existingTag) => existingTag.text).includes(tag.text)) {
          oldStory.tags.push(tag)
        }
      })
      this.emit_data_change(
        [oldStory.href, "tags"],
        oldStory.tags,
        previousTags,
        null
      )
      oldStory = (await this.options.saveStory?.(oldStory)) || oldStory
    }

    const oldCommentUrls = oldStory.substories.map((substory) => {
      return substory.comment_url
    })

    if (
      newStory.comment_url != oldStory.comment_url &&
      !oldCommentUrls.includes(newStory.comment_url)
    ) {
      const previousSubstories = oldStory.substories
      oldStory.substories.push({
        type: newStory.type,
        comment_url: newStory.comment_url,
        timestamp: newStory.timestamp,
        tags: newStory.tags
      })
      this.emit_data_change(
        [oldStory.href, "substories"],
        oldStory.substories,
        previousSubstories,
        null
      )
      oldStory = (await this.options.saveStory?.(oldStory)) || oldStory
    }

    return oldStory
  }
}
