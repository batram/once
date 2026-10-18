export const options = {
  id: "hackernews",
  type: "HN",
  description: "HTML HackerNews (news.ycombinator.com)",
  pattern: "https://news.ycombinator.com/",
  collects: "dom",
  colors: ["rgba(255, 102, 0, 0.56)", "white"],
  // The front page turns over fast enough that an hour-old copy is a
  // different page; four minutes is close to how often it actually changes.
  cache_minutes: 4,
  settings: {
    filter_ads: {
      value: true,
      description: "Filter advertising for job oppenings without comments"
    }
  }
}

const site_url = "https://news.ycombinator.com/"
const item_url = "https://news.ycombinator.com/item?id="
const user_url = "https://news.ycombinator.com/submitted?id="

import { Story } from "@once/core"
import type { SearchIO } from "./searchIO"

/**
 * The submission time HN puts in the age span's title: an ISO time in UTC,
 * optionally followed by Unix seconds. "3 hours ago" depends on when the page
 * was read, so two devices would store different stories for the same item.
 */
function exactTime(title: string | null | undefined): number | undefined {
  const [iso, unix] = (title ?? "").trim().split(/\s+/)
  if (unix && /^\d+$/.test(unix)) return Number(unix) * 1000
  if (!iso) return undefined
  const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : `${iso}Z`)
  return Number.isFinite(parsed) ? parsed : undefined
}

export function parse(doc: Document): Story[] {
  const curl = item_url
  const stories = Array.from(doc.querySelectorAll<HTMLElement>(".athing"))

  return stories.flatMap((story_el) => {
    const story_link = story_el.querySelector<HTMLAnchorElement>(".titleline > a")
    const subtext = story_el.nextElementSibling

    if (!story_link || !story_link.href || !story_link.innerText || !subtext) {
      return []
    }

    // Self posts link relatively ("item?id=…"). Resolve against the site
    // rather than trusting the DOM: a real browser resolves against whatever
    // base the page has, and a test DOM does not resolve at all.
    const id = story_el.id
    const href = new URL(story_link.getAttribute("href") ?? "", site_url).href

    const age = subtext.querySelector<HTMLElement>(".age")
    const time = age?.querySelector<HTMLAnchorElement>("a")?.innerText ?? ""
    const timestamp = exactTime(age?.getAttribute("title")) ?? 0
    if (!time || !Number.isFinite(timestamp)) {
      return []
    }

    //filter ads
    let filter = ""
    if (options.settings.filter_ads.value) {
      if (story_el.querySelector(".votelinks") == null) {
        filter = ":: HN ads ::"
      }
    }

    const new_story = new Story(
      options.type,
      href,
      story_link.innerText,
      id ? curl + id : "",
      timestamp,
      filter
    )

    const user_el = subtext.querySelector<HTMLAnchorElement>(".hnuser")
    if (user_el) {
      const user_id = user_el.innerText

      const user_tag = {
        class: "user",
        text: user_id,
        href: user_url + user_id
      }
      new_story.tags.push(user_tag)
    }

    return [new_story]
  })
}

export function domain_search(needle: string, io: SearchIO): Promise<Story[]> {
  const domain_search_url =
    "https://hn.algolia.com/api/v1/search_by_date?tags=story&restrictSearchableAttributes=url&typoTolerance=false&query="
  return hn_search(needle, io, domain_search_url)
}

export function global_search(needle: string, io: SearchIO): Promise<Story[]> {
  return hn_search(needle, io)
}

async function hn_search(needle: string, io: SearchIO, alt_url?: string): Promise<Story[]> {
  let search_url =
    "https://hn.algolia.com/api/v1/search_by_date?tags=story&restrictSearchableAttributes=url,title&typoTolerance=false&query="
  if (alt_url) {
    search_url = alt_url
  }

  const res = await io.fetch(search_url + encodeURIComponent(needle))

  if (res.ok) {
    const json_response = await res.json()

    const searchfield = document.querySelector<HTMLInputElement>("#searchfield")

    if (!alt_url && searchfield?.value != needle) {
      //search changed bail
      return []
    }
    const search_stories = json_response.hits.map(
      (result: {
        objectID: string
        created_at: string
        url: string
        title: string
        author: string
      }) => {
        const curl = item_url + result.objectID

        const timestamp = Date.parse(result.created_at)

        const new_story = Story.from_obj({
          type: "HN",
          bucket: "global_search_results",
          search_result: needle,
          href: result.url || curl,
          title: result.title,
          comment_url: curl,
          timestamp: timestamp
        })

        const user_tag = {
          class: "user",
          text: result.author,
          href: user_url + result.author
        }
        new_story.tags.push(user_tag)

        return new_story
      }
    )
    return search_stories
  }
  return []
}
