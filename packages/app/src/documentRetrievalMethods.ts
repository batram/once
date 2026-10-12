import { fetchDocument, fetchText, retrieveDocument } from "./fetchDocument"
import type { OncePlatformPorts } from "./types"

export function documentRetrievalMethods(platform: OncePlatformPorts) {
  const fetch = platform.documentFetch ?? platform.fetch
  return {
    livePageHtml: async (url: string) => await platform.livePage?.html(url) ?? null,
    retrieveDocument: (url: string) => retrieveDocument(fetch, url, platform.textRecognition, platform.pdfText),
    fetchDocument: (url: string, paginate?: boolean) => fetchDocument(fetch, url, platform.textRecognition, platform.pdfText, paginate),
    fetchText: (url: string) => fetchText(platform.fetch, url)
  }
}
