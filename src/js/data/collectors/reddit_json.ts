const options = {
  tag: "re",
  description:
    "Collect stories from HackerNews (https://old.reddit.com/) by parsing json of subreddits",
  pattern: "https://old.reddit.com/*.json",
  collects: "json",
  colors: ["#cee3f8", "black"],
  settings: {
    filter_ads: {
      value: true,
      description: "Filter advertising for job oppenings without comments",
    },
  },
}

import { Story } from "../Story"

export { parse, options, domain_search, global_search }

interface RedditJSONData {
  kind: "Listing"
  data: {
    children: [
      {
        data: {
          permalink: string
          url: string
          title: string
          id: string
          created_utc: number
        }
      }
    ]
  }
}

function parse(json: RedditJSONData) {
  console.debug(json)
  //Parse as RSS and not HTML ...
  if (json.kind == "Listing") {
    return json.data.children.map((story) => {
      return new Story(
        options.tag,
        story.data.url,
        story.data.title,
        "https://old.reddit.com" + story.data.permalink,
        story.data.created_utc * 1000
      )
    })
  } else {
    console.error("Can't handle reddit json of kind ", json.kind, json)
  }
  return []
}

function domain_search(domain: string) {
  return global_search("site:" + domain)
}

async function global_search(needle: string) {
  let search_url = "https://old.reddit.com/search.json?q="

  let res = await fetch(search_url + encodeURIComponent(needle))
  if (res.ok) {
    let json_response = await res.json()
    return parse(json_response)
  }
  return []
}
