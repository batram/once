//import * as path from "path"
//import * as fs from "fs"
import { Story } from "../data/Story"

export declare interface StoryParser {
  options: {
    type: string
    desription: string
    pattern: string | string[]
    collects: "dom" | "json" | "xml"
    colors: [string, string]
    settings?: Record<string, unknown>
  }

  parse: (
    input: Document | Record<string, unknown>,
    url: string,
    og_url: string
  ) => Story[]
  global_search: (needle: string) => Promise<Story[]>
  domain_search: (needle: string) => Promise<Story[]>
  resolve_url?: (entry: string) => string
}

export function get_active(): StoryParser[] {
  //TODO: determine if active from settings
  const normalizedPath = "" //path.join(__dirname, "collectors")

  let collectors = [
    "geny_match",
    "json_select",
    "hackernews_html",
    "lobsters_html",
    "reddit_json",
    "reddit_rss",
    "twitter_html",
    "vanilla_rss",
  ]

  return collectors.map((x) => {
    return require("./collectors/" + x)
  })
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
