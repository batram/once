import { domain_search_providers, global_search_providers } from "@once/collectors"
import type { Story } from "@once/core"
import type { OncePlatformPorts } from "./types"

/**
 * Searches every collector that can, with the shell's fetch: a renderer's own
 * fetch carries none of the cookies the user signed in with, and Reddit, for
 * one, will not search for an anonymous reader.
 */
export function searchMethods(platform: Pick<OncePlatformPorts, "fetch">) {
  const io = { fetch: platform.fetch }
  return {
    searchCollectors: (scope: "global" | "domain", needle: string): Promise<Story[]>[] =>
      scope === "domain"
        ? domain_search_providers().map((provider) => provider.domain_search(needle, io))
        : global_search_providers().map((provider) => provider.global_search(needle, io))
  }
}
