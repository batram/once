import { convertLegacySourceLines, readLegacySourceLine } from "./legacySourceLines"
import {
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
  const lines = text.replace(/\r\n?/g, "\n").split("\n")
  const invalid = lines.map((line) => line.trim()).filter(Boolean).find((line) => {
    if (line.startsWith("*")) return line.length === 1
    const parsed = readLegacySourceLine(line)
    if ("problem" in parsed) return true
    try { return !["http:", "https:"].includes(new URL(parsed.url).protocol) } catch { return true }
  })
  if (invalid) return { ok: false, reports: [{ path: "legacy", message: `Invalid source line: ${invalid}` }] }
  const converted = convertLegacySourceLines(lines)
  if (!existing) return { ok: true, doc: converted.doc, reports: converted.reports }
  const reconciled = reconcileStorySources(converted.doc.sources, existing.sources)
  return {
    ok: true,
    doc: { ...existing, groups: converted.doc.groups, sources: reconciled.sources },
    reports: [...converted.reports, ...reconciled.reports]
  }
}

export function serializeStorySourceDocument(doc: StorySourceDocument): string {
  const lines = ["{", `  "version": ${doc.version},`]
  if (doc.migratedFrom) lines.push(`  "migratedFrom": ${JSON.stringify(doc.migratedFrom)},`)
  lines.push(`  "groups": ${JSON.stringify(doc.groups)},`, '  "sources": [')
  doc.sources.forEach((source, index) => {
    lines.push(`    ${JSON.stringify(source)}${index < doc.sources.length - 1 ? "," : ""}`)
  })
  lines.push("  ]", "}")
  return lines.join("\n")
}
