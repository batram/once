/** Identity of the current page, supplied by the browser rather than inferred from its URL. */
export interface StoryPageContext {
  sourceUrl?: string
  statusCode?: number
  failed?: boolean
}

/** Fragment jumps do not change which page a story refers to. Keep path and query intact. */
export function storyDocumentUrl(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return url
    parsed.hash = ""
    return parsed.href
  } catch { return url }
}

export function sameStoryDocument(left: string | undefined, right: string): boolean {
  return typeof left === "string" && left.length > 0 && storyDocumentUrl(left) === storyDocumentUrl(right)
}

/** Only observed page provenance creates an alias; unrelated navigation never inherits it. */
export function storyPageUrls(url: string, context?: StoryPageContext): string[] {
  if (context?.failed || (context?.statusCode ?? 0) >= 400) return []
  // Some sites redirect to an explicit error route with a successful HTTP status.
  if (context?.sourceUrl && !sameStoryDocument(context.sourceUrl, url)) {
    try {
      if (/\/(?:404|410|500|502|503|error|not-found|not_found)(?:\/|$)/i.test(new URL(url).pathname)) return []
    } catch { return [] }
  }
  return Array.from(new Set([url, context?.sourceUrl].filter((value): value is string => Boolean(value))))
}
