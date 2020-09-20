const options = {
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

export { parse, options, domain_search, global_search }

function parse(doc: Document) {
  let curl = "https://news.ycombinator.com/item?id="
  let stories = Array.from(doc.querySelectorAll(".storylink"))

  return stories.map((story_el: HTMLAnchorElement) => {
    let pawpaw = story_el.parentElement.parentElement
    let id = pawpaw.id
    if (story_el.protocol == "file:") {
      story_el.href = curl + id
    }

    let time = pawpaw.nextElementSibling.querySelector<HTMLAnchorElement>(
      ".age a"
    ).innerText
    let timestamp = parse_human_time(time)

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

function domain_search(needle: string) {
  let domain_search_url =
    "https://hn.algolia.com/api/v1/search_by_date?tags=story&restrictSearchableAttributes=url&query="
  return hn_search(needle, domain_search_url)
}

function global_search(needle: string) {
  return hn_search(needle)
}

async function hn_search(needle: string, alt_url?: string) {
  let search_url =
    "https://hn.algolia.com/api/v1/search_by_date?tags=story&restrictSearchableAttributes=url,title&query="
  if (alt_url) {
    search_url = alt_url
  }

  let res = await fetch(search_url + encodeURIComponent(needle))

  if (res.ok) {
    let json_response = await res.json()

    let searchfield = document.querySelector<HTMLInputElement>("#searchfield")

    if (!alt_url && searchfield.value != needle) {
      //search changed bail
      return
    }
    let search_stories = json_response.hits.map((result: any) => {
      /*
       //add the tag if we have not ingested stories from HN yet
     let type = "HN"
      let colors: [string, string] = ["rgba(255, 102, 0, 0.56)", "white"]
      menu.add_tag(type, colors)
      */

      let curl = "https://news.ycombinator.com/item?id=" + result.objectID

      let timestamp = Date.parse(result.created_at)

      return Story.from_obj({
        type: "HN",
        bucket: "global_search_results",
        search_result: needle,
        href: result.url || curl,
        title: result.title,
        comment_url: curl,
        timestamp: timestamp,
        sources: [{ type: "HN", comment_url: curl, timestamp: timestamp }],
      })
    })
    return search_stories
  }
  return []
}
