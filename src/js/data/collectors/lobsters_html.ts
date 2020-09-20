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
import { DomainSearchProvider } from "../collectors"

export { parse, options, domain_search }

function parse(doc: Document) {
  let curl = "https://lobste.rs/s/"
  let stories = Array.from(doc.querySelectorAll<HTMLElement>(".story"))
  console.log("lobsters parsers", stories)

  return stories
    .map((story) => {
      let id = story.dataset.shortid
      let link = story.querySelector<HTMLAnchorElement>(".u-url")
      if (!link) {
        return null
      }
      if (link.protocol == "file:") {
        link.href = curl + id
      }

      let timestamp = Date.parse(
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

async function domain_search(domain: string) {
  let search_url = "https://lobste.rs/domain/"
  let res = await fetch(search_url + domain)
  if (res.ok) {
    let content = await res.text()
    let dom_parser = new DOMParser()
    let doc = dom_parser.parseFromString(content, "text/html")
    return parse(doc)
  } else {
    return []
  }
}

function search_lobsters_ddg(needle: string) {
  fetch(
    "https://html.duckduckgo.com/html/?q=site:lobste.rs/s/%20" +
      encodeURIComponent(needle)
  ).then((x) => {
    if (x.ok) {
      x.text().then(async (val) => {
        let searchfield = document.querySelector<HTMLInputElement>(
          "#searchfield"
        )
        if (searchfield.value != needle) {
          //search changed bail
          return
        }

        //TODO: think about it
      })
    }
  })
}
