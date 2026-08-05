import { DEFAULT_GROUP_ID, groupedStorySources, StorySource, StorySourceDocument } from "@once/core"

export interface SourceGroup {
  id: string
  name: string
  sources: StorySource[]
}

export function groupsFromDocument(doc: StorySourceDocument): SourceGroup[] {
  return groupedStorySources(doc).map((group) => ({ ...group, sources: [...group.sources] }))
}

export function documentFromGroups(groups: SourceGroup[], base: StorySourceDocument): StorySourceDocument {
  const sources = groups.flatMap((group) => group.sources.map((source) => {
    const next = { ...source }
    if (group.id === DEFAULT_GROUP_ID) delete next.groupId
    else next.groupId = group.id
    return next
  }))
  return { ...base, groups: groups.slice(1).map(({ id, name }) => ({ id, name })), sources }
}

export function parseSourceGroups(lines: string[]): SourceGroup[] {
  const groups: SourceGroup[] = [{ id: "default", name: "Default", sources: [] }]
  let current = groups[0]
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith("*")) {
      current = {
        id: `group-${groups.length}`,
        name: line.slice(1),
        sources: []
      }
      groups.push(current)
    } else {
      current.sources.push({ id: `src_legacy${String(current.sources.length).padStart(8, "0")}`, url: line })
    }
  }
  return groups
}

export function serializeSourceGroups(groups: SourceGroup[]): string[] {
  return groups.flatMap((group, index) => [
    ...(index === 0 ? [] : [`*${group.name}`]),
    ...group.sources.map((source) => source.url)
  ])
}
