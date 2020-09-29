export const options = {
  tag: "re",
  description:
    "Collect stories from HackerNews (https://old.reddit.com/) by parsing json of subreddits",
  pattern: "https://old.reddit.com/*.json",
  collects: "json",
  colors: ["#cee3f8", "black"],
  settings: {},
}

import { Story } from "../Story"

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

export function parse(json: RedditJSONData): Story[] {
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

export function domain_search(domain: string): Promise<Story[]> {
  return global_search("site:" + domain)
}

export async function global_search(needle: string): Promise<Story[]> {
  const search_url = "https://old.reddit.com/search.json?q="

  const res = await fetch(search_url + encodeURIComponent(needle))
  if (res.ok) {
    const json_response = await res.json()
    return parse(json_response)
  }
  return []
}
