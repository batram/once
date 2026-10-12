import { AiResolvedModel } from "./index"

export type ReaderBlockKind = "p" | "h2" | "h3" | "h4" | "li"
export interface ReaderFormatBlock { id: string; text: string; kind: ReaderBlockKind; repairable?: boolean }
export interface ReaderBlockEdit { id: string; kind: ReaderBlockKind; text?: string }
export interface ReaderFormatResult { blocks: ReaderBlockEdit[]; model: AiResolvedModel; generatedAt: string }
export interface AiProvenance { operation: "formatting" | "ocr"; connection: string; provider: string; model: string; generatedAt: string }
export function readFormatBlocks(value: unknown): ReaderFormatBlock[] {
  if (!Array.isArray(value) || !value.length || value.length > 1000) throw new Error("Reader formatting needs between 1 and 1000 text blocks")
  const ids = new Set<string>()
  let size = 0
  return value.map(raw => {
    if (!raw || typeof raw.id !== "string" || !/^b\d{1,5}$/.test(raw.id) || ids.has(raw.id) || typeof raw.text !== "string" || !["p", "h2", "h3", "h4", "li"].includes(raw.kind)) throw new Error("Invalid reader block")
    size += raw.text.length
    if (size > 128000) throw new Error("This article is too long for AI formatting")
    ids.add(raw.id)
    return { id: raw.id, text: raw.text, kind: raw.kind, ...(raw.repairable === true ? { repairable: true } : {}) }
  })
}
export function readFormatEdits(text: string, source: ReaderFormatBlock[]): ReaderBlockEdit[] {
  let value: unknown
  try { value = JSON.parse(text.replace(/^```(?:json)?\s*\n?/, "").replace(/\n?```\s*$/, "")) } catch { throw new Error("AI formatting returned invalid structure; original retained") }
  if (!Array.isArray(value) || value.length !== source.length) throw new Error("AI formatting omitted source blocks; original retained")
  return value.map((raw, index) => {
    if (!raw || raw.id !== source[index].id || !["p", "h2", "h3", "h4", "li"].includes(raw.kind) || Object.keys(raw).some(key => key !== "id" && key !== "kind" && key !== "text")) throw new Error("AI formatting changed source content or order; original retained")
    if (raw.text !== undefined && (typeof raw.text !== "string" || !source[index].repairable || raw.text.length > source[index].text.length * 2 + 100 || repairWords(raw.text) !== repairWords(source[index].text))) throw new Error("AI formatting rewrote source wording; original retained")
    return { id: raw.id, kind: raw.kind, ...(raw.text !== undefined ? { text: raw.text } : {}) }
  })
}

/** Permit whitespace changes and joining words broken by a hyphen at a line end. */
function repairWords(text: string): string { return text.replace(/([\p{L}\p{N}])-\s*\n\s*(?=[\p{L}\p{N}])/gu, "$1").replace(/\s+/g, " ").trim() }
