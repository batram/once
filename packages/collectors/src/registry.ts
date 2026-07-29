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
  global_search?: (needle: string) => Promise<Story[]>
  domain_search?: (needle: string) => Promise<Story[]>
  resolve_url?: (entry: string) => string
}

export type GlobalSearchProvider = StoryParser &
  Required<Pick<StoryParser, "global_search">>
export type DomainSearchProvider = StoryParser &
  Required<Pick<StoryParser, "domain_search">>

export function get_active(): StoryParser[] {
  return [
    {
      options: genyMatch.options,
      parse: genyMatch.parse,
      resolve_url: genyMatch.resolve_url
    },
    {
      options: hackerNewsHtml.options,
      parse: hackerNewsHtml.parse,
      domain_search: hackerNewsHtml.domain_search,
      global_search: hackerNewsHtml.global_search
    },
    {
      options: jsonSelect.options,
      parse: jsonSelect.parse,
      resolve_url: jsonSelect.resolve_url
    },
    {
      options: lobstersHtml.options,
      parse: lobstersHtml.parse,
      domain_search: lobstersHtml.domain_search,
      global_search: lobstersHtml.global_search
    },
    {
      options: redditJson.options,
      parse: redditJson.parse,
      domain_search: redditJson.domain_search,
      global_search: redditJson.global_search
    },
    {
      options: redditRss.options,
      parse: redditRss.parse
    },
    {
      options: twitterHtml.options,
      parse: twitterHtml.parse
    },
    {
      options: vanillaRss.options,
      parse: vanillaRss.parse
    }
  ] as StoryParser[]
}

export function get_parser(): StoryParser[] {
  return get_active().filter((parser: StoryParser) => {
    return Object.prototype.hasOwnProperty.call(parser, "parse")
  })
}

export function global_search_providers(): GlobalSearchProvider[] {
  return get_active().filter((parser): parser is GlobalSearchProvider => {
    return parser.global_search !== undefined
  })
}

export function domain_search_providers(): DomainSearchProvider[] {
  return get_active().filter((parser): parser is DomainSearchProvider => {
    return parser.domain_search !== undefined
  })
}
