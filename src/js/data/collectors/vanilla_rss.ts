const options = {
  tag: "RSS",
  description: "Collect stories from RSS feed",
  pattern: "*.rss",
  collects: "xml",
  colors: ["#f98e31", "white"],
  settings: {
    time_cut_off: {
      value: 31,
      description: "Only display articles younger than X days.",
    },
    discard_timeless: {
      value: true,
      description: "Ignore stories that have no timestamp",
    },
  },
}

import { Story } from "../Story"

export { parse, options }

function parse(doc: Document): Story[] {
  if (!doc) {
    return []
  }

  if (
    (doc.firstElementChild.nodeName == "rss" &&
      doc.firstElementChild.getAttribute("version") == "2.0") ||
    doc.firstElementChild.getAttribute("xmlns") == "http://purl.org/rss/1.0/"
  ) {
    return parse_rss_2(doc)
  } else if (
    doc.firstElementChild.nodeName == "feed" &&
    doc.firstElementChild.getAttribute("xmlns") == "http://www.w3.org/2005/Atom"
  ) {
    return parse_atom(doc)
  } else {
    console.error(
      "rest",
      doc.firstElementChild.nodeName,
      doc.firstElementChild.getAttribute("version"),
      doc
    )
  }
}

function parse_rss_2(doc: Document) {
  const def: FeedFormat = {
    story_tag: "item",
    title_tag: "title",
    timestamp_tags: ["pubDate", "pubdate", "dc:date"],
    link_tags: [
      "feedburner:origLink",
      "link",
      { tag: "guid", startsWith: "http" },
    ],
    content_tags: [
      { tag: "content:encoded", minLength: 1000 },
      { tag: "description", minLength: 1000 },
    ],
  }
  return common_rss_parser(doc, def)
}

const day_off = 24 * 60 * 60 * 1000

function parse_atom(doc: Document) {
  const def: FeedFormat = {
    story_tag: "entry",
    title_tag: "title",
    timestamp_tags: ["updated"],
    link_tags: [{ tag: "link", attr: "href" }],
    content_tags: [{ tag: "content", minLength: 1000 }],
  }
  return common_rss_parser(doc, def)
}

declare interface FeedFromatTag {
  tag: string
  attr?: string
  startsWith?: string
  minLength?: number
}

declare interface FeedFormat {
  story_tag: string
  title_tag: string
  timestamp_tags: (string | FeedFromatTag)[]
  link_tags: (string | FeedFromatTag)[]
  content_tags: (string | FeedFromatTag)[]
}

function get_feed_value(
  story: Element,
  tag_formats: (string | FeedFromatTag)[]
) {
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
      } else {
        value = element.textContent
      }

      if (value && typeof value == "string") {
        if (tag_format.startsWith && !value.startsWith(tag_format.startsWith)) {
          value = null
        }

        if (
          tag_format.minLength &&
          value &&
          value.length &&
          value.length < tag_format.minLength
        ) {
          value = null
        }
      }

      if (value) {
        return value
      }
    }
  }
}

function common_rss_parser(doc: Document, def: FeedFormat) {
  const items = doc.querySelectorAll(def.story_tag)

  const stories = Array.from(items).map((story) => {
    let timestamp: string | number = get_feed_value(story, def.timestamp_tags)
    if (timestamp) {
      timestamp = Date.parse(timestamp)
      if (
        Date.now() - timestamp >
        options.settings.time_cut_off.value * day_off
      ) {
        return null
      }
    } else {
      if (!timestamp && options.settings.discard_timeless.value) {
        return
      } else {
        timestamp = Date.now()
      }
    }

    const title = get_feed_value(story, [def.title_tag])
    const link = get_feed_value(story, def.link_tags)
    const content = get_feed_value(story, def.content_tags)

    if (!link || !title) {
      console.error("no link or title? byebye", story, doc)
      return
    }

    const new_story = new Story(options.tag, link, title, link, timestamp)
    if (content) {
      new_story._attachments = {
        content: {
          content_type: "text/plain",
          data: new Blob([content], { type: "text/plain" }),
        },
      }
    }
    return new_story
  })
  console.debug("rss :: ", doc, stories)
  return stories.filter((x) => x != undefined)
}
