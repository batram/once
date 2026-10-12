import { AiResolvedModel } from "./index"
export const READER_AI_CHANNEL = "once-reader-ai"
export interface ReaderAiRequest {
  id: string
  documentId?: string
  action: "rewrite" | "cancel"
  sourceUrl: string
  /** The reader's own extraction, sent alongside whatever the source itself offers. */
  html?: string
  title?: string
}
/** The model's sanitized fragment; its leading heading, when present, is the reader's new title. */
export interface ReaderRewriteResult { html: string; model: AiResolvedModel; generatedAt: string }
export function readReaderAiRequest(value: unknown): ReaderAiRequest {
  const raw = value as ReaderAiRequest | null
  if (!raw || typeof raw.id !== "string" || raw.id.length > 100 || !["rewrite", "cancel"].includes(raw.action) || typeof raw.sourceUrl !== "string" || raw.sourceUrl.length > 4096 || !/^https?:\/\//.test(raw.sourceUrl)) throw new Error("Invalid reader AI request")
  if (raw.html !== undefined && (typeof raw.html !== "string" || raw.html.length > 1024 * 1024)) throw new Error("Reader AI content is too large")
  if (raw.title !== undefined && (typeof raw.title !== "string" || raw.title.length > 500)) throw new Error("Invalid reader title")
  if (raw.documentId !== undefined && (typeof raw.documentId !== "string" || !raw.documentId || raw.documentId.length > 100)) throw new Error("Invalid reader source identity")
  return { id: raw.id, action: raw.action, sourceUrl: raw.sourceUrl, ...(raw.documentId !== undefined ? { documentId: raw.documentId } : {}), ...(raw.html !== undefined ? { html: raw.html } : {}), ...(raw.title !== undefined ? { title: raw.title } : {}) }
}
export interface ReaderAiResponse { id: string; value?: unknown; error?: string; code?: string; progress?: string }
