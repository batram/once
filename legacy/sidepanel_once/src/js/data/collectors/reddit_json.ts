export const options = {
  type: "re",
  description:
    "Collect stories from HackerNews (https://old.reddit.com/) by parsing json of subreddits",
  pattern: "https://old.reddit.com/*.json",
  collects: "json",
  colors: ["#cee3f8", "black"],
  settings: {
    min_points: 35,
  },
}

import { Story } from "../Story"

interface RedditJSONData {
  kind: "Listing"
  data: {
    children: [
      {
        data: {
          author: string
          permalink: string
          url: string
          title: string
          id: string
          created_utc: number
          subreddit: string
          subreddit_name_prefixed: string
          ups: number
        }
      }
    ]
  }
}

export function parse(
  json: RedditJSONData,
  url: string,
  og_url: string,
  filter = true
): Story[] {
  if (json.kind == "Listing") {
    return json.data.children
      .map((story) => {
        if (filter && story.data.ups < options.settings.min_points) {
          return
        }
        const new_story = new Story(
          options.type,
          story.data.url,
          story.data.title,
          "https://old.reddit.com" + story.data.permalink,
          story.data.created_utc * 1000
        )

        const user_tag = {
          class: "user",
          text: story.data.author,
          href:
            "https://old.reddit.com/user/" + story.data.author + "/submitted/",
        }
        new_story.tags.push(user_tag)

        const subreddit = "/" + story.data.subreddit_name_prefixed
        const subreddit_tag = {
          class: "channel",
          text: subreddit,
          href: "https://old.reddit.com" + subreddit,
        }
        new_story.tags.push(subreddit_tag)

        return new_story
      })
      .filter((x) => x != undefined)
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
    return parse(json_response, "", "", false)
  }
  return []
}
