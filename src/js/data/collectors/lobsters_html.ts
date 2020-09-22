const options = {
  tag: "LO",
  colors: ["rgba(143, 0, 0, 0.56)", "white"],
  description:
    "Collect stories from Lobsters (https://lobste.rs/) by parsing HTML",
  pattern: "https://lobste.rs/",
  collects: "dom",
  settings: {
    filter_ads: {
      value: true,
      description: "Filter advertising for job oppenings without comments",
    },
  },
}

import { Story } from "../../data/Story"

export { parse, options, domain_search }

function parse(doc: Document): Story[] {
  const curl = "https://lobste.rs/s/"
  const stories = Array.from(doc.querySelectorAll<HTMLElement>(".story"))

  return stories
    .map((story) => {
      const id = story.dataset.shortid
      const link = story.querySelector<HTMLAnchorElement>(".u-url")
      if (!link) {
        return null
      }
      if (link.protocol == "file:") {
        link.href = curl + id
      }

      const timestamp = Date.parse(
        story.querySelector<HTMLElement>(".byline span").title
      )

      return new Story(
        options.tag,
        link.href,
        link.innerText,
        curl + id,
        timestamp
      )
    })
    .filter((x) => x != null)
}

async function domain_search(domain: string): Promise<Story[]> {
  const search_url = "https://lobste.rs/domain/"
  const res = await fetch(search_url + domain)
  if (res.ok) {
    const content = await res.text()
    const dom_parser = new DOMParser()
    const doc = dom_parser.parseFromString(content, "text/html")
    return parse(doc)
  } else {
    return []
  }
}
