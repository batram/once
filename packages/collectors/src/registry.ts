import { Story } from "@once/core"
import * as genyMatch from "./collectors/genyMatch"
import * as hackerNewsHtml from "./collectors/hackerNewsHtml"
import * as jsonSelect from "./collectors/jsonSelect"
import * as lobstersHtml from "./collectors/lobstersHtml"
import * as redditJson from "./collectors/redditJson"
import * as redditRss from "./collectors/redditRss"
import * as twitterHtml from "./collectors/twitterHtml"
import * as vanillaRss from "./collectors/vanillaRss"

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
