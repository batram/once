import { AiResolvedModel } from "./index"
export const READER_AI_CHANNEL = "once-reader-ai"
export interface ReaderAiRequest {
  id: string
  documentId?: string
  /** `pages` reads more of a long scan on the device; `rewrite` sends content to the model. */
  action: "rewrite" | "pages" | "cancel"
  sourceUrl: string
  /** The reader's own extraction, sent alongside whatever the source itself offers. */
  html?: string
  title?: string
  /** A page range of a long scan read in parts. */
  pages?: { from: number; to: number }
  /** The end of what the reader shows, so a rewrite of the next pages continues it. */
  previous?: string
}
/** How far a long scan read in parts has come: pages 1 to `through` of `total`. */
export interface ReaderPages { through: number; total: number }
/** The model's sanitized fragment; its leading heading, when present, is the reader's new title. */
export interface ReaderRewriteResult { html: string; model: AiResolvedModel; generatedAt: string; pages?: ReaderPages }
/** Plain paragraphs of the pages read on the device. */
export interface ReaderPagesResult { paragraphs: string[]; pages: ReaderPages }
/** Pages one request may cover. */
const MAX_PAGE_WINDOW = 20
export function readReaderAiRequest(value: unknown): ReaderAiRequest {
  const raw = value as ReaderAiRequest | null
  if (!raw || typeof raw.id !== "string" || raw.id.length > 100 || !["rewrite", "pages", "cancel"].includes(raw.action) || typeof raw.sourceUrl !== "string" || raw.sourceUrl.length > 4096 || !/^https?:\/\//.test(raw.sourceUrl)) throw new Error("Invalid reader AI request")
  if (raw.html !== undefined && (typeof raw.html !== "string" || raw.html.length > 1024 * 1024)) throw new Error("Reader AI content is too large")
  if (raw.title !== undefined && (typeof raw.title !== "string" || raw.title.length > 500)) throw new Error("Invalid reader title")
  if (raw.previous !== undefined && (typeof raw.previous !== "string" || raw.previous.length > 2000)) throw new Error("Invalid reader context")
  if (raw.documentId !== undefined && (typeof raw.documentId !== "string" || !raw.documentId || raw.documentId.length > 100)) throw new Error("Invalid reader source identity")
  const pages = raw.pages
  if (pages !== undefined && (!pages || !Number.isInteger(pages.from) || !Number.isInteger(pages.to) || pages.from < 1 || pages.to < pages.from || pages.to - pages.from >= MAX_PAGE_WINDOW)) throw new Error("Invalid reader page range")
  if (raw.action === "pages" && !pages) throw new Error("Reading pages needs a page range")
  return {
    id: raw.id, action: raw.action, sourceUrl: raw.sourceUrl,
    ...(raw.documentId !== undefined ? { documentId: raw.documentId } : {}), ...(raw.html !== undefined ? { html: raw.html } : {}),
    ...(raw.title !== undefined ? { title: raw.title } : {}), ...(pages ? { pages: { from: pages.from, to: pages.to } } : {}),
    ...(raw.previous !== undefined ? { previous: raw.previous } : {})
  }
}
export interface ReaderAiResponse { id: string; value?: unknown; error?: string; code?: string; progress?: string }
