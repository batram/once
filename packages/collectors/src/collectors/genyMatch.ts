export const options = {
  id: "geny",
  type: "GY",
  colors: ["rgba(123, 123, 0, 0.56)", "white"],
  description: "HTML geny match",
  // Never detected from a URL: a source using this collector names it, and
  // carries its selectors in `select`.
  pattern: [] as string[],
  collects: "dom",
  settings: {}
}

import { mintStorySourceId, Story, StorySource, StoryTag } from "@once/core"
import { ParseContext } from "../registry"
import { sanitizeSelectorConf } from "../selectorConf"

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
  const elem = selector.sel ? parent_el.querySelectorAll<HTMLElement>(selector.sel) : []
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

export function parse(doc: Document, context: ParseContext): Story[] {
  // Nothing to select with is not an error: an unconfigured source simply has
  // no stories in it. Configuration that is present but wrong does throw, from
  // sanitize_selector_conf, so it reaches the source-error surface.
  if (context.config === undefined) return []
  const selectors = sanitize_selector_conf(context.config)

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

      const new_story = new Story(options.type, href, title, comment_href, timestamp)

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

function parse_tag(tag_sel: TagSelector, story: HTMLElement): StoryTag | undefined {
  const elements = tag_sel.elements
  if (!elements?.text) {
    throw new Error("geny_match tag config is missing elements.text")
  }
  const tclass = elements.class ? (selecti(elements.class, story) as string) : "category"
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

/**
 * Validates untrusted selector configuration (for example produced by the
 * in-page source picker) and returns a copy containing only known fields.
 * The shape is shared with jsonSelect; only the processors differ.
 */
export function sanitize_selector_conf(raw: unknown): GenySelectorConf {
  return sanitizeSelectorConf(raw, {
    label: "geny_match config",
    processors: processor_functions
  }) as GenySelectorConf
}

/** Builds the validated typed source returned by each source picker. */
export function build_source(conf: GenySelectorConf, url: string): StorySource {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("geny_match sources must use HTTP or HTTPS")
  }
  return {
    id: mintStorySourceId(),
    url: parsed.toString(),
    collector: "geny",
    select: sanitize_selector_conf(conf)
  }
}
