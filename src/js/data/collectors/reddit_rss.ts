const options = {
  tag: "re",
  description:
    "Collect stories from HackerNews (https://old.reddit.com/) by parsing the rss feed of subreddits",
  pattern: "https://old.reddit.com/*.rss",
  collects: "dom",
  colors: ["#cee3f8", "black"],
  settings: {
    filter_ads: {
      value: true,
      description: "Filter advertising for job oppenings without comments",
    },
  },
}

import { Story } from "../../data/Story"

export { parse, options }

function parse(doc: Document) {
  //Parse as RSS and not HTML ...
  let stories = doc.querySelectorAll("entry")

  return Array.from(stories).map((story) => {
    let dom_parser = new DOMParser()
    let content = dom_parser.parseFromString(
      story.querySelector<HTMLElement>("content").innerText,
      "text/html"
    )

    let timestamp = Date.parse(
      story.querySelector<HTMLElement>("updated").innerText
    )

    return new Story(
      options.tag,
      content.querySelector<HTMLAnchorElement>("span a").href,
      story.querySelector("title").innerText,
      story.querySelector("link").href,
      timestamp
    )
  })
}
