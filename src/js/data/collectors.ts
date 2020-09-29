import * as path from "path"
import * as fs from "fs"
import { Story } from "../data/Story"

export declare interface StoryParser {
  options: {
    tag: string
    desription: string
    pattern: string
    collects: "dom" | "json" | "xml"
    colors: [string, string]
    settings?: Record<string, unknown>
  }

  parse: (input: Document | Record<string, unknown>) => Story[]
  global_search: (needle: string) => Promise<Story[]>
  domain_search: (needle: string) => Promise<Story[]>
}

export function get_active(): StoryParser[] {
  //TODO: determine if active from settings
  const normalizedPath = path.join(__dirname, "collectors")

  return fs
    .readdirSync(normalizedPath)
    .map((file_name: string) => {
      //TODO: better check
      if (file_name.endsWith(".js")) {
        return require(path.join(normalizedPath, file_name))
      }
    })
    .filter((x: string) => {
      return x != undefined
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
