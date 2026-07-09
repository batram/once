export function groupStorySources(
  storySources: string[]
): Record<string, string[]> {
  const groupedSources: Record<string, string[]> = {
    default: []
  }
  let currentGroup = "default"

  storySources.forEach((sourceEntry) => {
    if (/^\*(.*)$/.test(sourceEntry)) {
      currentGroup = sourceEntry.replace(/^\*/, "")
      groupedSources[currentGroup] = []
    } else {
      groupedSources[currentGroup].push(sourceEntry)
    }
  })

  return groupedSources
}
