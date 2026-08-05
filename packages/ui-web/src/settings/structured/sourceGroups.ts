import {
  DEFAULT_GROUP_ID,
  groupedStorySources,
  StorySource,
  StorySourceDocument
} from "@once/core"

export interface SourceGroup {
  id: string
  name: string
  sources: StorySource[]
}

export function groupsFromDocument(doc: StorySourceDocument): SourceGroup[] {
  return groupedStorySources(doc).map((group) => ({
    ...group,
    sources: [...group.sources]
  }))
}

export function documentFromGroups(
  groups: SourceGroup[],
  base: StorySourceDocument
): StorySourceDocument {
  const sources = groups.flatMap((group) => group.sources.map((source) => {
    const next = { ...source }
    if (group.id === DEFAULT_GROUP_ID) delete next.groupId
    else next.groupId = group.id
    return next
  }))
  return {
    ...base,
    groups: groups.slice(1).map(({ id, name }) => ({ id, name })),
    sources
  }
}
