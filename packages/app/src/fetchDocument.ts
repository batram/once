import { documentHtml, recognizeResponse, recognizedDocument, RetrievedDocument, TextRecognitionPort } from "./textRetrieval"

/**
 * Media types the reader can extract from. XHTML is included because sites that
 * serve `application/xhtml+xml` (build2.org, for one) are ordinary articles;
 * only the declared type differs.
 */
const READABLE_MEDIA_TYPES = new Set([
  "text/html",
  "application/xhtml+xml"
])

export async function retrieveDocument(
  fetch: typeof globalThis.fetch,
  url: string,
  recognition?: TextRecognitionPort
): Promise<RetrievedDocument> {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Reader mode only supports HTTP and HTTPS pages")
  }
  const response = await fetch(parsed.toString(), { credentials: "omit" })
  if (!response.ok) {
    if (response.status === 429) {
      throw new Error(
        "The site rate-limited the reader request (HTTP 429). Try again later or open the original page."
      )
    }
    const detail = response.statusText ? `: ${response.statusText}` : ""
    throw new Error(
      `The reader request failed with HTTP ${response.status}${detail}`
    )
  }
  const contentType = response.headers.get("content-type") || ""
  const mediaType = contentType.split(";")[0].trim().toLowerCase()
  if (mediaType.startsWith("image/")) {
    const result = await recognizeResponse(response, recognition)
    return recognizedDocument(result, response.url || parsed.toString(), mediaType)
  }
  if (!READABLE_MEDIA_TYPES.has(mediaType)) {
    throw new Error(
      `Reader mode cannot display ${contentType || "this content type"}`
    )
  }
  return {
    kind: "html",
    html: await response.text(),
    url: response.url || parsed.toString(),
    mediaType
  }
}

/** Add-on code is small; anything past this is not a script we want to run. */
const MAX_TEXT_BYTES = 1024 * 1024

/** Fetches a text resource, http(s) only, without credentials and within a size cap. */
export async function fetchText(
  fetch: typeof globalThis.fetch,
  url: string
): Promise<string> {
  const parsed = new URL(url)
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("Only HTTP and HTTPS resources can be fetched")
  }
  const response = await fetch(parsed.toString(), { credentials: "omit" })
  if (!response.ok) {
    throw new Error(`The request failed with HTTP ${response.status}`)
  }
  const length = Number(response.headers.get("content-length") ?? 0)
  if (length > MAX_TEXT_BYTES) throw new Error("The resource is too large")
  const text = await response.text()
  if (text.length > MAX_TEXT_BYTES) throw new Error("The resource is too large")
  return text
}

/** Compatibility adapter for reader and stored-content consumers. */
export async function fetchDocument(fetch: typeof globalThis.fetch, url: string, recognition?: TextRecognitionPort): Promise<{ html: string; url: string; mediaType: string }> {
  const result = await retrieveDocument(fetch, url, recognition)
  return { html: documentHtml(result), url: result.url, mediaType: result.kind === "text" ? "text/plain" : result.mediaType }
}
