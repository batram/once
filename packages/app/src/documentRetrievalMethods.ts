import { fetchDocument, fetchText, retrieveDocument } from "./fetchDocument"
import type { OncePlatformPorts } from "./types"

export function documentRetrievalMethods(platform: OncePlatformPorts) {
  const fetch = openDocumentFetch(platform)
  return {
    livePageHtml: async (url: string) => await platform.livePage?.html(url) ?? null,
    retrieveDocument: (url: string) => retrieveDocument(fetch, url, platform.textRecognition, platform.pdfText),
    fetchDocument: (url: string, paginate?: boolean) => fetchDocument(fetch, url, platform.textRecognition, platform.pdfText, paginate),
    fetchText: (url: string) => fetchText(platform.fetch, url)
  }
}

/**
 * The platform's document fetch, answering with the PDF an open page already
 * shows for that URL when there is one. A site behind a bot challenge lets the
 * page's own navigation through and refuses any separate request with 403, so
 * the bytes the page holds are the only copy the reader or the AI can get.
 */
export function openDocumentFetch(platform: OncePlatformPorts): typeof globalThis.fetch {
  const network = platform.documentFetch ?? platform.fetch
  const live = platform.livePage
  if (!live?.pdf) return network
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const open = await live.pdf?.(url).catch(() => null)
    init?.signal?.throwIfAborted()
    if (!open) return network(input, init)
    // Copied so the body owns a plain ArrayBuffer whatever the bridge handed over.
    return new Response(new Uint8Array(open.bytes), { status: 200, headers: { "content-type": "application/pdf" } })
  }
}
