import * as path from "path"
import * as fs from "fs"
import { Story } from "../data/Story"
export {
  get_active,
  get_parser,
  global_search_providers,
  domain_search_providers,
}

function get_active() {
  //TODO: determine if active from settings
  var normalizedPath = path.join(__dirname, "collectors")

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

function get_parser() {
  return get_active().filter((x: string) => {
    return x.hasOwnProperty("parse")
  })
}

export declare interface GlobalSearchProvider {
  global_search: (needle: string) => Promise<Story[]>
}

function global_search_providers(): GlobalSearchProvider[] {
  return get_active().filter((x: string) => {
    return x.hasOwnProperty("global_search")
  })
}

export declare interface DomainSearchProvider {
  domain_search: (needle: string) => Promise<Story[]>
}

function domain_search_providers(): DomainSearchProvider[] {
  return get_active().filter((x: string) => {
    return x.hasOwnProperty("domain_search")
  })
}
