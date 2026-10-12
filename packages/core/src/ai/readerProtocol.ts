import { AiProvenance, ReaderFormatBlock, readFormatBlocks } from "./readerFormatting"
import { AiResolvedModel, readAiSelection } from "./index"
export const READER_AI_CHANNEL = "once-reader-ai"
export interface ReaderAiRequest {
  id: string
  documentId?: string
  action: "resolve" | "format" | "ocr" | "save" | "cancel"
  sourceUrl: string
  blocks?: ReaderFormatBlock[]
  model?: AiResolvedModel
  provenance?: AiProvenance
  text?: string
  html?: string
  title?: string
  consumer?: "reader.formatting" | "reader.ocr"
}
export function readReaderAiRequest(value: unknown): ReaderAiRequest {
  const raw = value as ReaderAiRequest | null
  if (!raw || typeof raw.id !== "string" || raw.id.length > 100 || !["resolve", "format", "ocr", "save", "cancel"].includes(raw.action) || typeof raw.sourceUrl !== "string" || raw.sourceUrl.length > 4096 || !/^https?:\/\//.test(raw.sourceUrl)) throw new Error("Invalid reader AI request")
  for (const text of [raw.text, raw.html]) if (text !== undefined && (typeof text !== "string" || text.length > 1024 * 1024)) throw new Error("Reader AI content is too large")
  if (raw.title !== undefined && (typeof raw.title !== "string" || raw.title.length > 500)) throw new Error("Invalid reader title")
  if (raw.consumer !== undefined && raw.consumer !== "reader.formatting" && raw.consumer !== "reader.ocr") throw new Error("Invalid reader consumer")
  if (raw.documentId !== undefined && (typeof raw.documentId !== "string" || !raw.documentId || raw.documentId.length > 100)) throw new Error("Invalid reader source identity")
  if (raw.blocks !== undefined) raw.blocks = readFormatBlocks(raw.blocks)
  if (raw.model !== undefined) {
    readAiSelection(raw.model)
    if (typeof raw.model.revision !== "string" || !/^[a-f0-9]{64}$/.test(raw.model.revision)) throw new Error("Invalid reader AI model")
  }
  if (raw.provenance !== undefined) {
    const data = raw.provenance
    if (!data || !["formatting", "ocr"].includes(data.operation) || [data.connection, data.provider, data.model, data.generatedAt].some(value => typeof value !== "string" || value.length > 200)) throw new Error("Invalid AI provenance")
  }
  return raw
}
export interface ReaderAiResponse { id: string; value?: unknown; error?: string; code?: string; progress?: string }
