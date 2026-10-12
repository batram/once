import { OnceClient } from "@once/app"
import { ReaderAiRequest, ReaderPagesResult, ReaderRewriteResult, readReaderAiRequest } from "@once/core"
import { sanitizedFragmentDocument } from "./sanitizeHtml"

/** Host-only dispatcher; adapters validate the sending frame before invoking this. */
export async function executeReaderAi(client: OnceClient, raw: ReaderAiRequest, signal?: AbortSignal, progress?: (text: string) => void): Promise<ReaderRewriteResult | ReaderPagesResult | undefined> {
  const request = readReaderAiRequest(raw)
  if (request.action === "cancel") return undefined
  // Plain text, which the reader inserts as text; nothing in it is markup.
  if (request.action === "pages" && request.pages) return client.readReaderPages(request.sourceUrl, request.pages, signal, progress)
  const result = await client.rewriteReaderAi({ sourceUrl: request.sourceUrl, html: request.html, title: request.title, pages: request.pages, previous: request.previous }, signal, progress)
  signal?.throwIfAborted()
  // The reader shows what the model wrote, so it passes the same allowlist as an extracted article.
  const html = sanitizedFragmentDocument(result.html, request.sourceUrl).body.innerHTML
  if (!html.trim()) throw new Error("The model returned nothing readable")
  return { ...result, html }
}
