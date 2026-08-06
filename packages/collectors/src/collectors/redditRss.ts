export const options = {
  id: "redditrss",
  type: "re",
  description:
    "Collect stories from Reddit (https://old.reddit.com/) by parsing the RSS feed of subreddits",
  pattern: "https://old.reddit.com/*.rss",
  collects: "dom",
  colors: ["#cee3f8", "black"],
  cache_minutes: 4,
  settings: {}
}

import { Story } from "@once/core"

export function parse(doc: Document): Story[] {
  //Parse as RSS and not HTML ...
  const stories = doc.querySelectorAll("entry")

  return Array.from(stories).flatMap((story) => {
    const dom_parser = new DOMParser()
    const content = dom_parser.parseFromString(
      story.querySelector<HTMLElement>("content")?.innerText ?? "",
      "text/html"
    )

    const updated = story.querySelector<HTMLElement>("updated")?.innerText
    const href = content.querySelector<HTMLAnchorElement>("span a")?.href
    const title = story.querySelector("title")?.innerText
    if (!updated || !href || !title) {
      return []
    }
    const timestamp = Date.parse(updated)

    return [
      new Story(
        options.type,
        href,
        title,
        story.querySelector("link")?.href ?? "",
        timestamp
      )
    ]
  })
}
