import { fetchDocument, retrieveDocument } from "./fetchDocument"
import type { OncePlatformPorts } from "./types"

export function documentRetrievalMethods(platform: OncePlatformPorts) {
  return {
    livePageHtml: async (url: string) => await platform.livePage?.html(url) ?? null,
    retrieveDocument: (url: string) => retrieveDocument(platform.fetch, url, platform.textRecognition),
    fetchDocument: (url: string) => fetchDocument(platform.fetch, url, platform.textRecognition)
  }
}
