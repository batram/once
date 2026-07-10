export function groupStorySources(
  storySources: string[]
): Record<string, string[]> {
  const groupedSources: Record<string, string[]> = {
    default: []
  }
  let currentGroup = "default"

  storySources.forEach((sourceEntry) => {
    const normalizedEntry = sourceEntry.trim()
    if (!normalizedEntry) return

    if (/^\*(.*)$/.test(normalizedEntry)) {
      currentGroup = normalizedEntry.replace(/^\*/, "")
      groupedSources[currentGroup] = []
    } else {
      groupedSources[currentGroup].push(normalizedEntry)
    }
  })

  return groupedSources
}
