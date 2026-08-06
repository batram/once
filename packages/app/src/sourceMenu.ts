import {
  enabledStorySources,
  groupedStorySources,
  StorySource,
  StorySourceDocument
} from "@once/core"

/** Always offered, whatever the sources currently produce. */
export const DEFAULT_MENU_TYPES = ["ALL", "filtered", "stared", "new"]

export interface SourceMenu {
  groups: string[]
  types: string[]
}

/**
 * The menu a set of sources implies: every group that has an enabled source in
 * it, and every collector badge those sources produce. Derived rather than
 * accumulated, so a disabled or deleted source leaves nothing behind.
 */
export function sourceMenuFromDocument(
  document: StorySourceDocument,
  parserTypeOf: (source: StorySource) => string
): SourceMenu {
  const groups: string[] = []
  const types = new Set(DEFAULT_MENU_TYPES)
  const enabled = new Set(enabledStorySources(document).map((source) => source.id))
  for (const group of groupedStorySources(document)) {
    const sources = group.sources.filter((source) => enabled.has(source.id))
    if (!sources.length) continue
    groups.push(group.name)
    for (const source of sources) {
      const parserType = parserTypeOf(source)
      if (parserType !== "Unknown") types.add(parserType)
    }
  }
  return { groups, types: [...types] }
}
