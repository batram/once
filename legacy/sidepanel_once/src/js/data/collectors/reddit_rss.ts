export const options = {
  type: "re",
  description:
    "Collect stories from HackerNews (https://old.reddit.com/) by parsing the rss feed of subreddits",
  pattern: "https://old.reddit.com/*.rss",
  collects: "dom",
  colors: ["#cee3f8", "black"],
  settings: {},
}

import { Story } from "../../data/Story"

export function parse(doc: Document): Story[] {
  //Parse as RSS and not HTML ...
  const stories = doc.querySelectorAll("entry")

  return Array.from(stories).map((story) => {
    const dom_parser = new DOMParser()
    const content = dom_parser.parseFromString(
      story.querySelector<HTMLElement>("content").innerText,
      "text/html"
    )

    const timestamp = Date.parse(
      story.querySelector<HTMLElement>("updated").innerText
    )

    return new Story(
      options.type,
      content.querySelector<HTMLAnchorElement>("span a").href,
      story.querySelector("title").innerText,
      story.querySelector("link").href,
      timestamp
    )
  })
}
