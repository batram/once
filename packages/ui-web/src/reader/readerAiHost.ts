import { OnceClient } from "@once/app"
import { ReaderAiRequest, ReaderRewriteResult, readReaderAiRequest } from "@once/core"
import { sanitizedFragmentDocument } from "./sanitizeHtml"

/** Host-only dispatcher; adapters validate the sending frame before invoking this. */
export async function executeReaderAi(client: OnceClient, raw: ReaderAiRequest, signal?: AbortSignal, progress?: (text: string) => void): Promise<ReaderRewriteResult | undefined> {
  const request = readReaderAiRequest(raw)
  if (request.action === "cancel") return undefined
  const result = await client.rewriteReaderAi({ sourceUrl: request.sourceUrl, html: request.html, title: request.title }, signal, progress)
  signal?.throwIfAborted()
  // The reader shows what the model wrote, so it passes the same allowlist as an extracted article.
  const html = sanitizedFragmentDocument(result.html, request.sourceUrl).body.innerHTML
  if (!html.trim()) throw new Error("The model returned nothing readable")
  return { ...result, html }
}
