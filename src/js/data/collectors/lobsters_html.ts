const options = {
  tag: "LO",
  colors: ["rgba(143, 0, 0, 0.56)", "white"],
  description:
    "Collect stories from Lobsters (https://lobste.rs/) by parsing HTML",
  pattern: "https://lobste.rs/",
  settings: {
    filter_ads: {
      value: true,
      description: "Filter advertising for job oppenings without comments",
    },
  },
}

import { Story } from "../../data/Story"

export { parse, options }

function parse(doc: Document, type: string) {
  let curl = "https://lobste.rs/s/"
  let stories = Array.from(doc.querySelectorAll<HTMLElement>(".story"))

  return stories.map((story) => {
    let id = story.dataset.shortid
    let link = story.querySelector<HTMLAnchorElement>(".u-url")
    if (link.protocol == "file:") {
      link.href = curl + id
    }

    let timestamp = Date.parse(
      story.querySelector<HTMLElement>(".byline span").title
    )

    return new Story(type, link.href, link.innerText, curl + id, timestamp)
  })
}
