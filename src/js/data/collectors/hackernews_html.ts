export const options = {
  tag: "HN",
  description:
    "Collect stories from HackerNews (https://news.ycombinator.com/) by parsing HTML",
  pattern: "https://news.ycombinator.com/",
  collects: "dom",
  colors: ["rgba(255, 102, 0, 0.56)", "white"],
  settings: {
    filter_ads: {
      value: true,
      description: "Filter advertising for job oppenings without comments",
    },
  },
}

import { Story } from "../../data/Story"
import { parse_human_time } from "../../data/parser"

export function parse(doc: Document): Story[] {
  const curl = "https://news.ycombinator.com/item?id="
  const stories = Array.from(doc.querySelectorAll(".storylink"))

  return stories.map((story_el: HTMLAnchorElement) => {
    const pawpaw = story_el.parentElement.parentElement
    const id = pawpaw.id
    if (story_el.protocol == "file:") {
      story_el.href = curl + id
    }

    const time = pawpaw.nextElementSibling.querySelector<HTMLAnchorElement>(
      ".age a"
    ).innerText
    const timestamp = parse_human_time(time)

    //filter ads
    let filter = null
    if (options.settings.filter_ads.value) {
      if (
        story_el.parentElement.parentElement.querySelector(".votelinks") == null
      ) {
        filter = ":: HN ads ::"
      }
    }

    return new Story(
      options.tag,
      story_el.href,
      story_el.innerText,
      curl + id,
      timestamp,
      filter
    )
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

    if (!alt_url && searchfield.value != needle) {
      //search changed bail
      return
    }
    const search_stories = json_response.hits.map(
      (result: {
        objectID: string
        created_at: string
        url: string
        title: string
      }) => {
        /*
       //add the tag if we have not ingested stories from HN yet
     let type = "HN"
      let colors: [string, string] = ["rgba(255, 102, 0, 0.56)", "white"]
      menu.add_tag(type, colors)
      */

        const curl = "https://news.ycombinator.com/item?id=" + result.objectID

        const timestamp = Date.parse(result.created_at)

        return Story.from_obj({
          type: "HN",
          bucket: "global_search_results",
          search_result: needle,
          href: result.url || curl,
          title: result.title,
          comment_url: curl,
          timestamp: timestamp,
        })
      }
    )
    return search_stories
  }
  return []
}
