export const options = {
  type: "HN",
  description:
    "Collect stories from HackerNews (https://news.ycombinator.com/) by parsing HTML",
  pattern: "https://news.ycombinator.com/",
  collects: "dom",
  colors: ["rgba(255, 102, 0, 0.56)", "white"],
  settings: {
    filter_ads: {
      value: true,
      description: "Filter advertising for job oppenings without comments"
    }
  }
}

const item_url = "https://news.ycombinator.com/item?id="
const user_url = "https://news.ycombinator.com/submitted?id="

import { Story } from "@once/core"
import { parseHumanTime } from "@once/core"

export function parse(doc: Document): Story[] {
  const curl = item_url
  const stories = Array.from(doc.querySelectorAll<HTMLElement>(".athing"))

  return stories.flatMap((story_el) => {
    const story_link =
      story_el.querySelector<HTMLAnchorElement>(".titleline > a")
    const subtext = story_el.nextElementSibling

    if (!story_link || !story_link.href || !story_link.innerText || !subtext) {
      return []
    }

    const id = story_el.id
    if (story_link.protocol == "file:") {
      story_link.href = curl + id
    }

    const time =
      subtext.querySelector<HTMLAnchorElement>(".age a")?.innerText ?? ""
    const timestamp = parseHumanTime(time)
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
      story_link.href,
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

export function domain_search(needle: string): Promise<Story[]> {
  const domain_search_url =
    "https://hn.algolia.com/api/v1/search_by_date?tags=story&restrictSearchableAttributes=url&query="
  return hn_search(needle, domain_search_url)
}

export function global_search(needle: string): Promise<Story[]> {
  return hn_search(needle)
}

async function hn_search(needle: string, alt_url?: string): Promise<Story[]> {
  let search_url =
    "https://hn.algolia.com/api/v1/search_by_date?tags=story&restrictSearchableAttributes=url,title&query="
  if (alt_url) {
    search_url = alt_url
  }

  const res = await fetch(search_url + encodeURIComponent(needle))

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
