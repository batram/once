/**
 * Find-in-page across the sandboxed reader frame. The host cannot reach the
 * frame's document, so it posts a query and the frame answers with the count;
 * the frame does the highlighting and scrolling itself.
 */
export const READER_FIND_CHANNEL = "once-reader-find"
export const READER_FIND_VERSION = 1

interface ReaderFindEnvelope {
  channel: typeof READER_FIND_CHANNEL
  version: typeof READER_FIND_VERSION
}

export type ReaderFindRequest = ReaderFindEnvelope & (
  | { type: "find"; query: string; forward: boolean }
  | { type: "clear" }
)

export type ReaderFindResponse = ReaderFindEnvelope & {
  type: "result"
  query: string
  /** 1-based index of the selected match, 0 when there is none. */
  current: number
  total: number
}

function isEnvelope(value: unknown): value is ReaderFindEnvelope {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<ReaderFindEnvelope>
  return candidate.channel === READER_FIND_CHANNEL &&
    candidate.version === READER_FIND_VERSION
}

export function isReaderFindRequest(value: unknown): value is ReaderFindRequest {
  if (!isEnvelope(value)) return false
  const candidate = value as Partial<ReaderFindRequest>
  if (candidate.type === "clear") return true
  return candidate.type === "find" &&
    typeof candidate.query === "string" &&
    typeof candidate.forward === "boolean"
}

export function isReaderFindResponse(value: unknown): value is ReaderFindResponse {
  if (!isEnvelope(value)) return false
  const candidate = value as Partial<ReaderFindResponse>
  return candidate.type === "result" &&
    typeof candidate.query === "string" &&
    Number.isInteger(candidate.current) &&
    Number.isInteger(candidate.total)
}

export function readerFindRequest(
  body: { type: "find"; query: string; forward: boolean } | { type: "clear" }
): ReaderFindRequest {
  return { channel: READER_FIND_CHANNEL, version: READER_FIND_VERSION, ...body }
}

export function readerFindResponse(
  body: { query: string; current: number; total: number }
): ReaderFindResponse {
  return { channel: READER_FIND_CHANNEL, version: READER_FIND_VERSION, type: "result", ...body }
}

/**
 * Every start offset of `query` in `text`, case-insensitively and without
 * overlaps. Pure so the search itself can be tested without a document.
 */
export function locateMatches(text: string, query: string): number[] {
  const offsets: number[] = []
  if (!query) return offsets
  const haystack = text.toLowerCase()
  const needle = query.toLowerCase()
  let from = 0
  for (;;) {
    const index = haystack.indexOf(needle, from)
    if (index < 0) return offsets
    offsets.push(index)
    from = index + needle.length
  }
}
