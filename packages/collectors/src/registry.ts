import { Story } from "@once/core"
import * as genyMatch from "./collectors/geny_match"
import * as hackerNewsHtml from "./collectors/hackernews_html"
import * as jsonSelect from "./collectors/json_select"
import * as lobstersHtml from "./collectors/lobsters_html"
import * as redditJson from "./collectors/reddit_json"
import * as redditRss from "./collectors/reddit_rss"
import * as twitterHtml from "./collectors/twitter_html"
import * as vanillaRss from "./collectors/vanilla_rss"

export declare interface StoryParser {
  options: {
    type: string
    description: string
    pattern: string | string[]
    collects: "dom" | "json" | "xml"
    colors: [string, string]
    settings?: Record<string, unknown>
  }

  parse: (
    input: Document | Record<string, unknown>,
    url?: string,
    og_url?: string
  ) => Story[]
  global_search: (needle: string) => Promise<Story[]>
  domain_search: (needle: string) => Promise<Story[]>
  resolve_url?: (entry: string) => string
}

export function get_active(): StoryParser[] {
  return [
    genyMatch,
    hackerNewsHtml,
    jsonSelect,
    lobstersHtml,
    redditJson,
    redditRss,
    twitterHtml,
    vanillaRss
  ] as StoryParser[]
}

export function get_parser(): StoryParser[] {
  return get_active().filter((parser: StoryParser) => {
    return Object.prototype.hasOwnProperty.call(parser, "parse")
  })
}

export function global_search_providers(): StoryParser[] {
  return get_active().filter((parser: StoryParser) => {
    return Object.prototype.hasOwnProperty.call(parser, "global_search")
  })
}

export function domain_search_providers(): StoryParser[] {
  return get_active().filter((parser: StoryParser) => {
    return Object.prototype.hasOwnProperty.call(parser, "domain_search")
  })
}
