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
 * The platform's document fetch, answering with what an open page already
 * shows for that URL when there is one: its PDF, or its page as the tab
 * rendered it. A site behind a bot challenge lets the page's own navigation
 * through and refuses any separate request with 403, so the page's copy is
 * often the only one the reader or the AI can get; where both could, it saves
 * a second download and is what the user is looking at.
 */
export function openDocumentFetch(platform: OncePlatformPorts): typeof globalThis.fetch {
  const network = platform.documentFetch ?? platform.fetch
  const live = platform.livePage
  if (!live) return network
  return async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
    const open = await openCopy(live, url)
    init?.signal?.throwIfAborted()
    return open ?? network(input, init)
  }
}

async function openCopy(live: NonNullable<OncePlatformPorts["livePage"]>, url: string): Promise<Response | null> {
  const pdf = await live.pdf?.(url).catch(() => null)
  // Copied so the body owns a plain ArrayBuffer whatever the bridge handed over.
  if (pdf) return answered(new Response(new Uint8Array(pdf.bytes), { status: 200, headers: { "content-type": "application/pdf" } }), pdf.url)
  const page = await live.html(url).catch(() => null)
  return page ? answered(new Response(page.html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } }), page.url) : null
}

/** Where the open page's copy came from; a redirect it followed shows here as for a fetch. */
function answered(response: Response, url: string): Response {
  Object.defineProperty(response, "url", { value: url })
  return response
}
