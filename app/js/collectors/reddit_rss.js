const options = {
  tag: "re",
  description:
    "Collect stories from HackerNews (https://old.reddit.com/) by parsing the rss feed of subreddits",
  pattern: "https://old.reddit.com/",
  colors: ["#cee3f8", "black"],
  settings: {
    filter_ads: {
      value: true,
      description: "Filter advertising for job oppenings without comments",
    },
  },
}

module.exports = {
  parse,
  options,
}

const { Story } = require("../data/Story")

function parse(doc, type) {
  //Parse as RSS and not HTML ...
  let stories = doc.querySelectorAll("entry")

  return Array.from(stories).map((story) => {
    let dom_parser = new DOMParser()
    let content = dom_parser.parseFromString(
      story.querySelector("content").innerText,
      "text/html"
    )

    let timestamp = Date.parse(story.querySelector("updated").innerText)

    return new Story(
      type,
      content.querySelector("span a").href,
      story.querySelector("title").innerText,
      story.querySelector("link").href,
      timestamp
    )
  })
}
