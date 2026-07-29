export interface SourceGroup {
  id: string
  name: string
  sources: string[]
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
      current.sources.push(line)
    }
  }
  return groups
}

export function serializeSourceGroups(groups: SourceGroup[]): string[] {
  return groups.flatMap((group, index) => [
    ...(index === 0 ? [] : [`*${group.name}`]),
    ...group.sources
  ])
}
