export const options = {
  id: "lobsters",
  type: "LO",
  colors: ["rgba(143, 0, 0, 0.56)", "white"],
  description: "HTML Lobsters (https://lobste.rs/)",
  pattern: "https://lobste.rs/",
  collects: "dom",
  // A quieter front page than the other two aggregators.
  cache_minutes: 10,
  settings: {}
}

import { Story, storyTimestamp } from "@once/core"
import type { SearchIO } from "./searchIO"

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
      // Self posts link relatively ("/s/…"). Resolve against the site rather
      // than trusting the DOM: a real browser resolves against whatever base
      // the page has, and a test DOM does not resolve at all.
      const href = new URL(link.getAttribute("href") ?? "", base_url).href

      const time_el = story.querySelector<HTMLElement>(".byline time")
      let timestamp = 0
      if (time_el) {
        const unix_sec = time_el.getAttribute("data-at-unix")
        if (unix_sec) {
          timestamp = parseInt(unix_sec, 10) * 1000
        } else if (time_el.title) {
          timestamp = storyTimestamp(time_el.title)
        }
      }

      // Prefer the slugged comments link. Lobsters page-caches the bare
      // /s/<id> path separately and never refreshes it, so it can show a
      // story frozen with no comments.
      const comments_href = story.querySelector(".comments_label a")?.getAttribute("href")
      const comment_url = comments_href
        ? new URL(comments_href, base_url).href
        : base_url + "/s/" + id

      const new_story = new Story(
        options.type,
        href,
        link.innerText,
        comment_url,
        timestamp
      )

      const user_links = Array.from(
        story.querySelectorAll<HTMLAnchorElement>(".byline a[href^='/~']")
      )
      const user_el = user_links.find((el) => el.innerText.trim().length > 0)
      if (user_el) {
        const username = user_el.innerText.trim()
        new_story.tags.push({
          class: "user",
          text: username,
          href: base_url + "/newest/" + username,
          icon: base_url + "/avatars/" + username + "-16.png"
        })
      }

      const tag_els = story.querySelectorAll<HTMLElement>(".tags .tag")
      tag_els.forEach((tag) => {
        const tag_name = tag.innerText
        new_story.tags.push({
          class: "category",
          text: tag_name,
          href: base_url + "/t/" + tag_name
        })
      })

      return new_story
    })
    .filter((x) => x != null)
}

export async function domain_search(domain: string, io: SearchIO): Promise<Story[]> {
  const search_url = "https://lobste.rs/domain/"
  const res = await io.fetch(search_url + domain)
  if (res.ok) {
    const content = await res.text()
    const dom_parser = new DOMParser()
    const doc = dom_parser.parseFromString(content, "text/html")
    return parse(doc)
  } else {
    return []
  }
}

// Lobsters answers a fetched search with its Anubis bot check, so search is
// offered as the site's own page, opened in a tab, rather than as results.
export const site_search = {
  label: "lobsters",
  url: (needle: string): string =>
    "https://lobste.rs/search?what=stories&order=relevance&q=" + encodeURIComponent(needle)
}
