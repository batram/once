export const options = {
  type: "LO",
  colors: ["rgba(143, 0, 0, 0.56)", "white"],
  description:
    "Collect stories from Lobsters (https://lobste.rs/) by parsing HTML",
  pattern: "https://lobste.rs/",
  collects: "dom",
  settings: {},
}

import { Story } from "../../data/Story"

export function parse(doc: Document): Story[] {
  const base_url = "https://lobste.rs"
  const stories = Array.from(doc.querySelectorAll<HTMLElement>(".story"))

  return stories
    .map((story) => {
      const id = story.dataset.shortid
      const link = story.querySelector<HTMLAnchorElement>(".u-url")
      if (!link) {
        return null
      }
      if (link.protocol == "file:") {
        link.href = base_url + "/s/" + id
      }

      let timestamp = Date.parse(
        story.querySelector<HTMLElement>(".byline time").title
      )

      const new_story = new Story(
        options.type,
        link.href,
        link.innerText,
        base_url + "/s/" + id,
        timestamp
      )

      const user_el = story.querySelector<HTMLElement>(".u-author")
      const username = user_el.innerText
      if (user_el) {
        new_story.tags.push({
          class: "user",
          text: username,
          href: base_url + "/newest/" + username,
          icon: base_url + "/avatars/" + username + "-16.png",
        })
      }

      const tag_els = story.querySelectorAll<HTMLElement>(".tags .tag")
      tag_els.forEach((tag) => {
        const tag_name = tag.innerText
        new_story.tags.push({
          class: "category",
          text: tag_name,
          href: base_url + "/t/" + tag_name,
        })
      })

      return new_story
    })
    .filter((x) => x != null)
}

export async function domain_search(domain: string): Promise<Story[]> {
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

export async function global_search(needle: string): Promise<Story[]> {
  const search_url = "https://lobste.rs/search?what=stories&order=relevance&q="

  const res = await fetch(search_url + encodeURIComponent(needle))
  if (res.ok) {
    const content = await res.text()
    const dom_parser = new DOMParser()
    const doc = dom_parser.parseFromString(content, "text/html")
    return parse(doc)
  }
  return []
}
