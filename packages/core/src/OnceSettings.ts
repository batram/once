import { Redirect } from "./url/Redirect"
import {
  defaultFilterList,
  defaultRedirectList,
  defaultSources,
  parseRedirectList,
  presentRedirectList
} from "./settings/defaults"
import { groupStorySources } from "./settings/sourceGroups"

export interface CoreSettingsProvider {
  story_sources(): Promise<string[]>
  grouped_story_sources(): Promise<Record<string, string[]>>
  get_filterlist(): Promise<string[]>
  get_redirectlist(): Promise<Redirect[]>
}

export class OnceSettings implements CoreSettingsProvider {
  static instance?: CoreSettingsProvider
  default_sources = defaultSources
  default_filterlist = defaultFilterList
  default_redirectlist = defaultRedirectList

  constructor(provider?: CoreSettingsProvider) {
    if (provider) {
      OnceSettings.instance = provider
    } else {
      OnceSettings.instance = this
    }
  }

  async story_sources(): Promise<string[]> {
    return this.default_sources
  }

  async grouped_story_sources(): Promise<Record<string, string[]>> {
    return groupStorySources(await this.story_sources())
  }

  async get_filterlist(): Promise<string[]> {
    return this.default_filterlist
  }

  async get_redirectlist(): Promise<Redirect[]> {
    return this.default_redirectlist
  }

  static parse_redirectlist(lines: string): Redirect[] {
    return parseRedirectList(lines)
  }

  static present_redirectlist(redirectList: Redirect[]): string {
    return presentRedirectList(redirectList)
  }
}
