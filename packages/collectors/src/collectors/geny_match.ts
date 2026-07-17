export const options = {
  type: "GY",
  colors: ["rgba(123, 123, 0, 0.56)", "white"],
  description: "Collect stories by parsing HTML and matching selectors",
  pattern: "geny:*",
  separator: "§§",
  collects: "dom",
  settings: {}
}

import { Story, StoryTag } from "@once/core"

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
  }
}

function selecti(selector: GenySelector, parent_el: HTMLElement): unknown {
  let ret: unknown = null
  const elem = selector.sel
    ? parent_el.querySelectorAll<HTMLElement>(selector.sel)
    : []
  if (selector.all) {
    ret = elem
  } else {
    ret = elem[0]
  }
  if (ret && selector.component) {
    ret = ret[selector.component as keyof (HTMLElement | HTMLElement[])]
  }
  if (!ret && selector.fallback !== undefined) {
    ret = selector.fallback
  }
  if (typeof ret === "string" && selector.processors) {
    //TODO: Post process stuff?
    selector.processors.forEach((processor) => {
      const processorFunction = processor_functions[processor]
      if (!processorFunction) {
        throw new Error(`Unknown geny_match processor: ${processor}`)
      }
      ret = processorFunction(ret as string)
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

export function parse(doc: Document, url: string, og_url: string): Story[] {
  //const base_url = url
  let selectors: GenySelectorConf = {}

  if (
    og_url.startsWith("geny:") &&
    og_url.split(options.separator).length >= 3
  ) {
    const split = og_url.split(options.separator, 3)
    try {
      selectors = JSON.parse(split[1])
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e)
      throw new Error(`geny_match config is invalid JSON: ${detail}`)
    }
  } else {
    return []
  }

  const { stories: stories_sel, link: link_sel, title: title_sel } = selectors
  if (!stories_sel || !link_sel || !title_sel) {
    throw new Error("geny_match config is missing stories, link, or title")
  }

  const stories = Array.from(selecti(stories_sel, doc.body) as HTMLElement[])

  return stories
    .map((story_el) => {
      const href = selecti(link_sel, story_el) as string
      const title = selecti(title_sel, story_el) as string
      if (typeof href !== "string" || !href.trim()) {
        throw new Error("geny_match link selector produced an empty value")
      }
      if (typeof title !== "string" || !title.trim()) {
        throw new Error("geny_match title selector produced an empty value")
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

function parse_tag(
  tag_sel: TagSelector,
  story: HTMLElement
): StoryTag | undefined {
  const elements = tag_sel.elements
  if (!elements?.text) {
    throw new Error("geny_match tag config is missing elements.text")
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

const MAX_SELECTOR_LENGTH = 500
const MAX_TAG_SELECTORS = 10
const MAX_TAG_ELEMENTS = 20

function sanitize_selector(raw: unknown, path: string): GenySelector {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`geny_match config ${path} must be an object`)
  }
  const source = raw as Record<string, unknown>
  const selector: GenySelector = {}
  for (const key of Object.keys(source)) {
    const value = source[key]
    if (key === "all") {
      if (typeof value !== "boolean") {
        throw new Error(`geny_match config ${path}.all must be a boolean`)
      }
      selector.all = value
    } else if (key === "sel" || key === "component" || key === "fallback") {
      if (typeof value !== "string" || value.length > MAX_SELECTOR_LENGTH) {
        throw new Error(`geny_match config ${path}.${key} must be a short string`)
      }
      selector[key] = value
    } else if (key === "processors") {
      if (
        !Array.isArray(value) ||
        value.some((name) => typeof name !== "string" || !processor_functions[name])
      ) {
        throw new Error(`geny_match config ${path}.processors must name known processors`)
      }
      selector.processors = value as string[]
    } else {
      throw new Error(`geny_match config ${path}.${key} is not a known selector field`)
    }
  }
  return selector
}

function sanitize_tag_selector(raw: unknown, path: string): TagSelector {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`geny_match config ${path} must be an object`)
  }
  const source = raw as Record<string, unknown>
  const tag: TagSelector = {}
  for (const key of Object.keys(source)) {
    if (key === "group_el") {
      tag.group_el = sanitize_selector(source[key], `${path}.group_el`)
    } else if (key === "elements") {
      const elements = source[key]
      if (
        typeof elements !== "object" ||
        elements === null ||
        Array.isArray(elements) ||
        Object.keys(elements).length > MAX_TAG_ELEMENTS
      ) {
        throw new Error(`geny_match config ${path}.elements must be a small object`)
      }
      tag.elements = {}
      for (const name of Object.keys(elements)) {
        tag.elements[name] = sanitize_selector(
          (elements as Record<string, unknown>)[name],
          `${path}.elements.${name}`
        )
      }
    } else {
      throw new Error(`geny_match config ${path}.${key} is not a known tag field`)
    }
  }
  return tag
}

// Validates untrusted selector configuration (for example produced by the
// in-page source picker) and returns a copy containing only known fields.
export function sanitize_selector_conf(raw: unknown): GenySelectorConf {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("geny_match config must be an object")
  }
  const source = raw as Record<string, unknown>
  const conf: GenySelectorConf = {}
  for (const key of Object.keys(source)) {
    if (
      key === "stories" ||
      key === "link" ||
      key === "title" ||
      key === "timestamp" ||
      key === "comment_href"
    ) {
      conf[key] = sanitize_selector(source[key], key)
    } else if (key === "tags") {
      const tags = source[key]
      if (!Array.isArray(tags) || tags.length > MAX_TAG_SELECTORS) {
        throw new Error("geny_match config tags must be a small array")
      }
      conf.tags = tags.map((tag, index) => sanitize_tag_selector(tag, `tags[${index}]`))
    } else {
      throw new Error(`geny_match config ${key} is not a known field`)
    }
  }
  if (!conf.stories || !conf.link || !conf.title) {
    throw new Error("geny_match config is missing stories, link, or title")
  }
  return conf
}

export function build_source(conf: GenySelectorConf, url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("geny_match sources must use HTTP or HTTPS")
  }
  const serialized = JSON.stringify(sanitize_selector_conf(conf))
  if (serialized.includes(options.separator)) {
    throw new Error("geny_match config must not contain the source separator")
  }
  return `geny:${options.separator}${serialized}${options.separator}${parsed.toString()}`
}

export function resolve_url(entry: string): string {
  if (entry.startsWith("geny:") && entry.split(options.separator).length >= 3) {
    const split = entry.split(options.separator, 3)
    //const conf = split[1]
    const url = split[2]
    return url
  } else {
    return entry
  }
}
