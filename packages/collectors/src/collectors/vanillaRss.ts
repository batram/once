export const options = {
  id: "rss",
  type: "RSS",
  description: "RSS feed collector",
  pattern: "*.rss",
  collects: "xml",
  colors: ["#f98e31", "white"],
  settings: {
    time_cut_off: {
      value: 31,
      description: "Only display articles younger than X days."
    },
    discard_timeless: {
      value: true,
      description: "Ignore stories that have no timestamp"
    },
    store_content: {
      value: true,
      description: "Keep the article text a feed includes, for the reader and offline"
    }
  }
}

import { daysAgo, feedContentIsArticle, Story } from "@once/core"

export function parse(doc: Document): Story[] {
  if (!doc) {
    return []
  }

  const root = doc.firstElementChild
  if (!root) {
    throw new Error("RSS feed has no root element")
  }

  if (
    (root.nodeName == "rss" && root.getAttribute("version") == "2.0") ||
    root.getAttribute("xmlns") == "http://purl.org/rss/1.0/"
  ) {
    return parse_rss_2(doc)
  } else if (
    root.nodeName == "feed" &&
    root.getAttribute("xmlns") == "http://www.w3.org/2005/Atom"
  ) {
    return parse_atom(doc)
  } else {
    throw new Error(
      `Unsupported feed format: ${root.nodeName} ${root.getAttribute("version") ?? ""}`.trim()
    )
  }
}

function parse_rss_2(doc: Document) {
  const def: FeedFormat = {
    main_title: ["title"],
    main_link: ["link"],
    story_tag: "item",
    title_tag: "title",
    timestamp_tags: ["pubDate", "pubdate", "dc:date"],
    link_tags: ["feedburner:origLink", "link", { tag: "guid", startsWith: "http" }],
    content_tags: ["content:encoded", "description"]
  }
  return common_rss_parser(doc, def)
}

function parse_atom(doc: Document) {
  const def: FeedFormat = {
    main_title: ["title"],
    main_link: [{ tag: "link", attr: "href" }],
    story_tag: "entry",
    title_tag: "title",
    timestamp_tags: ["updated", "published"],
    link_tags: [{ tag: "link", attr: "href" }],
    content_tags: [{ tag: "content", html: true }, { tag: "summary", html: true }]
  }
  return common_rss_parser(doc, def)
}

declare interface FeedFromatTag {
  tag: string
  attr?: string
  startsWith?: string
  /** Read the element as Atom text content: honour its `type` attribute. */
  html?: boolean
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
}

/**
 * Atom text constructs carry their markup three ways: `xhtml` as child
 * elements, `html` as escaped text, and `text` as plain text. RSS has only the
 * escaped form, so the helper is Atom's alone.
 */
function atomHtml(element: Element): string {
  const type = (element.getAttribute("type") ?? "text").toLowerCase()
  if (type === "xhtml") {
    const container = element.firstElementChild
    return (container?.localName === "div" ? container : element).innerHTML
  }
  const text = element.textContent ?? ""
  if (type === "html" || type === "text/html" || type === "application/xhtml+xml") return text
  return text.trim() ? `<p>${escapeHtml(text)}</p>` : ""
}

declare interface FeedFormat {
  main_title: (string | FeedFromatTag)[]
  main_link: (string | FeedFromatTag)[]
  story_tag: string
  title_tag: string
  timestamp_tags: (string | FeedFromatTag)[]
  link_tags: (string | FeedFromatTag)[]
  content_tags: (string | FeedFromatTag)[]
}

function get_feed_value(
  story: Element,
  tag_formats: (string | FeedFromatTag)[]
): string | undefined {
  for (let tag_format of tag_formats) {
    if (typeof tag_format == "string") {
      tag_format = { tag: tag_format }
    }

    let value = null
    const elements = story.getElementsByTagName(tag_format.tag)
    if (elements.length != 0) {
      const element = elements[0]
      if (tag_format.attr) {
        value = element.getAttribute(tag_format.attr)
      } else if (tag_format.html) {
        value = atomHtml(element)
      } else {
        value = element.textContent
      }

      if (value && typeof value == "string") {
        if (tag_format.startsWith && !value.startsWith(tag_format.startsWith)) {
          value = null
        }
      }

      if (value) {
        return value
      }
    }
  }

  return undefined
}

function common_rss_parser(doc: Document, def: FeedFormat) {
  const items = doc.querySelectorAll(def.story_tag)

  const main_title = get_feed_value(doc.documentElement, def.main_title)
  const main_link = get_feed_value(doc.documentElement, def.main_link)

  const stories = Array.from(items).map((story) => {
    let timestamp: string | number | undefined = get_feed_value(story, def.timestamp_tags)
    if (timestamp) {
      timestamp = Date.parse(timestamp)
      if (!Number.isFinite(timestamp)) {
        return
      }
      if (daysAgo(timestamp) > options.settings.time_cut_off.value) {
        return
      }
    } else {
      if (!timestamp && options.settings.discard_timeless.value) {
        return
      } else {
        timestamp = Date.now()
      }
    }

    let title = get_feed_value(story, [def.title_tag])
    const link = get_feed_value(story, def.link_tags)
    const content = get_feed_value(story, def.content_tags)

    if (!title && content) {
      title = content.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().substring(0, 500)
    }

    if (!link || !title) {
      return
    }

    const new_story = new Story(options.type, link, title, link, timestamp)

    // The feed already delivered the text, so keeping it costs no request;
    // a teaser is left out because the page would show more than it does.
    if (content && options.settings.store_content.value && feedContentIsArticle(content)) {
      new_story.attachContent(content, { source: "feed", saved_at: Date.now() })
    }

    if (main_title) {
      const user_tag = {
        class: "user",
        text: main_title,
        href: main_link
      }
      new_story.tags.push(user_tag)
    }

    return new_story
  })
  //console.debug("rss :: ", doc, stories)
  return stories.filter((x): x is Story => x != undefined)
}
