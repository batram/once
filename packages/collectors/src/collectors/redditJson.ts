export const options = {
  id: "redditjson",
  type: "re",
  description: "JSON Reddit (old.reddit.com)",
  pattern: "https://old.reddit.com/*.json",
  collects: "json",
  colors: ["#cee3f8", "black"],
  cache_minutes: 4,
  settings: {
    min_points: 35
  }
}

import { Story } from "@once/core"
import type { SearchIO } from "./searchIO"

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

/**
 * The score threshold used to be switchable through a second positional
 * argument, which `parse_response` unwittingly filled with the source URL — a
 * non-empty string, so filtering was always on and the switch was unreachable.
 * It is now simply always on, which is what the app has always actually done.
 */
export function parse(json: RedditJSONData): Story[] {
  return parse_listing(json, true)
}

function parse_listing(json: RedditJSONData, filter: boolean): Story[] {
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
          href: "https://old.reddit.com/user/" + story.data.author + "/submitted/"
        }
        new_story.tags.push(user_tag)

        const subreddit = "/" + story.data.subreddit_name_prefixed
        const subreddit_tag = {
          class: "channel",
          text: subreddit,
          href: "https://old.reddit.com" + subreddit
        }
        new_story.tags.push(subreddit_tag)

        return new_story
      })
      .filter((x) => x != undefined)
  } else {
    throw new Error(`Unsupported Reddit JSON kind: ${json.kind}`)
  }
}

export function domain_search(domain: string, io: SearchIO): Promise<Story[]> {
  return global_search("site:" + domain, io)
}

export async function global_search(needle: string, io: SearchIO): Promise<Story[]> {
  const search_url = "https://old.reddit.com/search.json?q="

  // Reddit answers anonymous JSON requests with its "Welcome to Reddit" page,
  // so search carries the user's session, as reading comments does.
  const res = await io.fetch(search_url + encodeURIComponent(needle), { credentials: "include" })
  if (!res.ok) return []
  let json_response: RedditJSONData
  try {
    json_response = JSON.parse(await res.text())
  } catch {
    console.warn("Reddit search answered with a page, not JSON; is the browser signed in?")
    return []
  }
  // Search results are what the user asked for by name, so the subreddit
  // score threshold does not apply to them.
  return parse_listing(json_response, false)
}
