export const options = {
  type: "GY",
  colors: ["rgba(123, 123, 0, 0.56)", "white"],
  description: "Collect stories by parsing HTML and matching selectors",
  pattern: "geny:*",
  seperator: "§§",
  collects: "dom",
  settings: {},
}

import { Story, StoryTag } from "../Story"

export interface GenySelector {
  sel?: string
  all?: boolean
  component?: string
  processors?: string[]
  fallback?: string
}
export interface TagSelector {
  group_el?: GenySelector
  elements?: Record<string, GenySelector>
}
export interface GenySelectorConf {
  stories?: GenySelector
  link?: GenySelector
  title?: GenySelector
  timestamp?: GenySelector
  comment_href?: GenySelector
  tags?: TagSelector[]
}

const processor_functions: Record<string, (arg0: string) => string> = {
  trim: (x: string) => {
    return x.trim()
  },
  show_path: (x: string) => {
    return "[{url.path}] " + x.trim()
  },
}

function selecti(selector: GenySelector, parent_el: HTMLElement): unknown {
  let ret: unknown = null
  const elem = parent_el.querySelectorAll<HTMLElement>(selector.sel)
  if (selector.all) {
    ret = elem
  } else {
    ret = elem[0]
  }
  if (ret && selector.component) {
    ret = ret[selector.component as keyof (HTMLElement | HTMLElement[])]
  }
  if (!ret && selector.fallback) {
    ret = selector.fallback
  }
  if (ret && selector.processors) {
    //TODO: Post process stuff?
    selector.processors.forEach((processor) => {
      ret = processor_functions[processor](ret as string)
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
      console.error("templating story failed", e)
    }
  }
  return story
}

export function parse(doc: Document, url: string, og_url: string): Story[] {
  //const base_url = url
  let selectors: GenySelectorConf = {}

  if (
    og_url.startsWith("geny:") &&
    og_url.split(options.seperator).length >= 3
  ) {
    const split = og_url.split(options.seperator, 3)
    try {
      selectors = JSON.parse(split[1])
    } catch (e) {
      console.error("geny_match failed to parse config", e)
      return []
    }
  } else {
    return []
  }

  const stories = Array.from(
    selecti(selectors.stories, doc.body) as HTMLElement[]
  )

  return stories
    .map((story_el) => {
      const href = selecti(selectors.link, story_el) as string
      const title = selecti(selectors.title, story_el) as string
      const comment_href = selectors.comment_href
        ? (selecti(selectors.comment_href, story_el) as string)
        : null
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

      selectors.tags.forEach((tag_sel) => {
        let tag_els = [story_el]
        if (tag_sel.group_el) {
          tag_els = selecti(tag_sel.group_el, story_el) as HTMLElement[]
        }
        tag_els.forEach((tag_el) => {
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

function parse_tag(tag_sel: TagSelector, story: HTMLElement): StoryTag {
  const tclass = tag_sel.elements.class
    ? (selecti(tag_sel.elements.class, story) as string)
    : "category"
  const text = selecti(tag_sel.elements.text, story) as string
  if (!text) {
    return
  }
  const new_tag: StoryTag = {
    class: tclass,
    text: text,
  }
  for (const key in tag_sel.elements) {
    if (key != "class" && key != "text") {
      new_tag[key as keyof StoryTag] = selecti(
        tag_sel.elements[key],
        story
      ) as string
    }
  }
  return new_tag
}

export function resolve_url(entry: string): string {
  if (entry.startsWith("geny:") && entry.split(options.seperator).length >= 3) {
    const split = entry.split(options.seperator, 3)
    //const conf = split[1]
    const url = split[2]
    return url
  } else {
    return entry
  }
}
