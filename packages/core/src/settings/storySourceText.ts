import {
  emptyStorySourceDocument,
  mintStorySourceGroupId,
  mintStorySourceId,
  reconcileStorySources,
  StorySourceDocument,
  StorySourceReport,
  parseStorySources
} from "./storySource"

export interface StorySourceTextResult {
  ok: boolean
  doc?: StorySourceDocument
  reports: StorySourceReport[]
}

export interface StorySourceTextRange {
  start: number
  end: number
}

export interface SerializedStorySourceDocument {
  text: string
  sourceRanges: ReadonlyMap<string, StorySourceTextRange>
}

export function parseStorySourceText(
  text: string,
  existing?: StorySourceDocument
): StorySourceTextResult {
  const first = text.trimStart()[0]
  if (first === "{" || first === "[") {
    let value: unknown
    try { value = JSON.parse(text) } catch (error) {
      return { ok: false, reports: [{ path: "JSON", message: error instanceof Error ? error.message : String(error) }] }
    }
    const read = parseStorySources(value)
    return read.ok ? { ok: true, doc: read.doc, reports: read.reports } : read
  }
  const imported = importUrlList(text, existing)
  if (!imported.ok) return imported
  if (!existing) return imported
  const reconciled = reconcileStorySources(imported.doc.sources, existing.sources)
  return {
    ok: true,
    doc: { ...existing, groups: imported.doc.groups, sources: reconciled.sources },
    reports: [...imported.reports, ...reconciled.reports]
  }
}

function importUrlList(
  text: string,
  existing?: StorySourceDocument
): { ok: true; doc: StorySourceDocument; reports: StorySourceReport[] } |
   { ok: false; reports: StorySourceReport[] } {
  const doc = emptyStorySourceDocument()
  const existingGroups = new Map<string, typeof doc.groups>()
  for (const group of existing?.groups ?? []) {
    const matches = existingGroups.get(group.name)
    if (matches) matches.push(group)
    else existingGroups.set(group.name, [group])
  }
  const claimedGroups = new Set<string>()
  let groupId: string | undefined
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim()
    if (!line) continue
    if (line.startsWith("*")) {
      const name = line.slice(1).trim()
      if (!name) {
        return { ok: false, reports: [{ path: `lines[${index}]`, message: "Group name is empty" }] }
      }
      const matched = (existingGroups.get(name) ?? [])
        .find((candidate) => !claimedGroups.has(candidate.id))
      groupId = matched?.id ?? mintStorySourceGroupId()
      claimedGroups.add(groupId)
      doc.groups.push({ id: groupId, name })
      continue
    }
    let url: URL
    try { url = new URL(line) } catch {
      return { ok: false, reports: [{ path: `lines[${index}]`, message: `Invalid source URL: ${line}` }] }
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return { ok: false, reports: [{ path: `lines[${index}]`, message: `Invalid source URL: ${line}` }] }
    }
    doc.sources.push({ id: mintStorySourceId(), url: line, ...(groupId ? { groupId } : {}) })
  }
  return { ok: true, doc, reports: [] }
}

export function serializeStorySourceDocument(doc: StorySourceDocument): string {
  return serializeStorySourceDocumentWithRanges(doc).text
}

export function serializeStorySourceDocumentWithRanges(
  doc: StorySourceDocument
): SerializedStorySourceDocument {
  const lines = ["{", `  "version": ${doc.version},`]
  if (doc.migratedFrom) lines.push(`  "migratedFrom": ${JSON.stringify(doc.migratedFrom)},`)
  lines.push(`  "groups": ${JSON.stringify(doc.groups)},`, '  "sources": [')
  const sourceRanges = new Map<string, StorySourceTextRange>()
  doc.sources.forEach((source, index) => {
    const prefixLength = lines.join("\n").length + 1
    const serialized = JSON.stringify(source)
    const start = prefixLength + 4
    sourceRanges.set(source.id, { start, end: start + serialized.length })
    lines.push(`    ${serialized}${index < doc.sources.length - 1 ? "," : ""}`)
  })
  lines.push("  ]", "}")
  return { text: lines.join("\n"), sourceRanges }
}
