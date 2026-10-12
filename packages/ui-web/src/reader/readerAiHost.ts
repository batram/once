import { OnceClient } from "@once/app"
import { ReaderAiRequest, readReaderAiRequest } from "@once/core"
import { sanitizedFragmentDocument } from "./sanitizeHtml"

/** Host-only dispatcher; adapters validate the sending frame before invoking this. */
export async function executeReaderAi(client: OnceClient, raw: ReaderAiRequest, signal?: AbortSignal, progress?: (text: string) => void): Promise<unknown> {
  const request = readReaderAiRequest(raw)
  switch (request.action) {
    case "resolve": return client.resolveAiModel(request.consumer ?? "reader.formatting")
    case "format": return client.formatReaderAi(request.blocks ?? [], signal, request.model)
    case "ocr": return client.readDocumentAi(request.sourceUrl, signal, progress, request.model)
    case "save": {
      signal?.throwIfAborted()
      if (!request.provenance) throw new Error("Generated content must include AI provenance")
      const html = sanitizedFragmentDocument(request.html ?? "", request.sourceUrl).body.innerHTML
      if (!html.trim()) throw new Error("No generated content to save")
      const story = await client.saveStoryContent(request.sourceUrl, html, { source: "page", title: request.title ?? "", saved_at: Date.now(), ai: request.provenance })
      if (!story) throw new Error("Save this page as a story before saving generated content")
      return true
    }
    case "cancel": return undefined
  }
}
