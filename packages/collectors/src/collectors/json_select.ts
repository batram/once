export const options = {
  type: "JX",
  colors: ["#868686", "white"],
  description: "Collect stories by selecting from JSON",
  pattern: "json:*",
  separator: "§§",
  collects: "json",
  settings: {}
}

import { Story, StoryTag } from "@once/core"

export interface JsonSelector {
  sel?: string
  all?: boolean
  component?: string
  processors?: string[]
  fallback?: string
}
export interface TagSelector {
  group_el?: JsonSelector
  elements?: Record<string, JsonSelector>
}
export interface JsonSelectorConf {
  stories?: JsonSelector
  link?: JsonSelector
  title?: JsonSelector
  timestamp?: JsonSelector
  comment_href?: JsonSelector
  tags?: TagSelector[]
}

const processor_functions: Record<string, (arg0: string) => string> = {
  trim: (x: string) => {
    return x.trim()
  },
  show_path: (x: string) => {
    return "[{url.path}] " + x.trim()
  }
}

function selecti(
  selector: JsonSelector,
  json: Record<string, unknown>
): unknown {
  let ret: unknown = null
  if (!selector.sel) return null
  const elem = json[selector.sel]
  if (selector.all || !Array.isArray(elem)) {
    ret = elem
  } else {
    ret = elem[0]
  }
  if (ret && selector.component && typeof ret === "object" && ret !== null) {
    ret = (ret as Record<string, unknown>)[selector.component]
  }
  if (!ret && selector.fallback) {
    ret = selector.fallback
  }
  if (ret && selector.processors) {
    //TODO: Post process stuff?
    selector.processors.forEach((processor) => {
      if (typeof ret === "string") {
        const processorFunction = processor_functions[processor]
        if (!processorFunction) {
          throw new Error(`Unknown json_select processor: ${processor}`)
        }
        ret = processorFunction(ret)
      }
    })
  }
  return ret
}

function process_templates(story: Story): Story {
  //TODO: generix template dings
  if (story.title && story.title.includes("{url.path}")) {
    try {
      const url = new URL(story.href)
      story.title = story.title.replace("{url.path}", url.pathname.slice(1))
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      throw new Error(`Story URL template failed: ${detail}`)
    }
  }
  return story
}

export function parse(
  json: Record<string, unknown>,
  url?: string,
  og_url?: string
): Story[] {
  let selectors: JsonSelectorConf = {}

  if (
    og_url &&
    og_url.startsWith("json:") &&
    og_url.split(options.separator).length >= 3
  ) {
    const split = og_url.split(options.separator, 3)
    try {
      selectors = JSON.parse(split[1])
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      throw new Error(`json_select config is invalid JSON: ${detail}`)
    }
  } else {
    return []
  }

  const { stories: stories_sel, link: link_sel, title: title_sel } = selectors
  if (!stories_sel || !link_sel || !title_sel) {
    throw new Error("json_select config is missing stories, link, or title")
  }

  const stories = Array.from(
    selecti(stories_sel, json) as Record<string, unknown>[]
  )

  return stories
    .map((story_el: Record<string, unknown>) => {
      const href = selecti(link_sel, story_el)
      if (typeof href !== "string" || !href) {
        throw new Error("json_select link selector produced an empty value")
      }
      const title = selecti(title_sel, story_el)
      if (typeof title !== "string" || !title) {
        throw new Error("json_select title selector produced an empty value")
      }
      const comment_href = selectors.comment_href
        ? (selecti(selectors.comment_href, story_el) as string)
        : ""
      const timestamp = selectors.timestamp
        ? Date.parse(selecti(selectors.timestamp, story_el) as string)
        : Date.now()

      const new_story = new Story(
        options.type,
        href,
        title,
        comment_href,
        timestamp
      )

      selectors.tags?.forEach((tag_sel) => {
        let tag_els = [story_el]
        if (tag_sel.group_el) {
          tag_els = selecti(tag_sel.group_el, story_el) as Record<
            string,
            unknown
          >[]
        }
        tag_els.forEach((tag_el: Record<string, unknown>) => {
          const new_tag = parse_tag(tag_sel, tag_el)
          if (new_tag) {
            new_story.tags.push(new_tag)
          }
        })
      })

      return process_templates(new_story)
    })
    .filter((x) => x != null)
}

function parse_tag(
  tag_sel: TagSelector,
  story: Record<string, unknown>
): StoryTag | undefined {
  const elements = tag_sel.elements
  if (!elements?.text) {
    throw new Error("json_select tag config is missing elements.text")
  }
  const tclass = elements.class
    ? (selecti(elements.class, story) as string)
    : "category"
  const text = selecti(elements.text, story) as string
  if (!text) {
    return undefined
  }
  const new_tag: StoryTag = {
    class: tclass,
    text: text
  }
  for (const key in elements) {
    if (key != "class" && key != "text") {
      new_tag[key as keyof StoryTag] = selecti(elements[key], story) as string
    }
  }
  return new_tag
}

export function resolve_url(entry: string): string {
  if (entry.startsWith("json:") && entry.split(options.separator).length >= 3) {
    const split = entry.split(options.separator, 3)
    //const conf = split[1]
    const url = split[2]
    return url
  } else {
    return entry
  }
}
