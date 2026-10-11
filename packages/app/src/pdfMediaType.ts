/**
 * Which responses are PDFs. Servers label them inconsistently: besides the
 * PDF type itself, many send a generic download type (or none) and let the
 * file name say what it is. Both the extension's navigation probe, which only
 * has headers, and document retrieval, which also has the bytes, decide here.
 */

const PDF_TYPES = new Set(["application/pdf", "application/x-pdf", "application/acrobat"])

/** Types that say only "a file", not which kind; the name or the bytes decide. */
const GENERIC_BINARY_TYPES = new Set([
  "",
  "application/octet-stream",
  "binary/octet-stream",
  "application/binary",
  "application/unknown",
  "application/download",
  "application/x-download",
  "application/force-download"
])

/** The bare, lower-case media type of a Content-Type header. */
export function mediaTypeOf(contentType: string | null | undefined): string {
  return (contentType ?? "").split(";")[0].trim().toLowerCase()
}

/** A missing or generic download type, which says nothing about the content. */
export function isGenericBinaryType(mediaType: string): boolean {
  return GENERIC_BINARY_TYPES.has(mediaType)
}

/** Whether headers alone identify a PDF: its own type, or a generic one on a `.pdf` URL or attachment name. */
export function isPdfByHeaders(url: string, contentType: string | null | undefined, disposition?: string | null): boolean {
  const type = mediaTypeOf(contentType)
  if (PDF_TYPES.has(type)) return true
  if (!isGenericBinaryType(type)) return false
  return /\.pdf$/i.test(new URL(url).pathname) || /\.pdf$/i.test(dispositionFilename(disposition))
}

/**
 * Whether a browser saves such a response rather than showing it: an
 * attachment, or a type its PDF viewer does not take. Without any type the
 * browser sniffs the bytes and shows the PDF.
 */
export function isDownloadByHeaders(contentType: string | null | undefined, disposition?: string | null): boolean {
  const type = mediaTypeOf(contentType)
  return /^\s*attachment\b/i.test(disposition ?? "") || (type !== "" && !PDF_TYPES.has(type))
}

/** The file name a Content-Disposition header gives, preferring the RFC 5987 `filename*` form. */
function dispositionFilename(disposition: string | null | undefined): string {
  if (!disposition) return ""
  const extended = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(disposition)
  if (extended) {
    try { return decodeURIComponent(extended[1].trim()) } catch { return extended[1].trim() }
  }
  return /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition)?.slice(1).find(name => name !== undefined)?.trim() ?? ""
}

/** PDF readers accept the `%PDF-` header anywhere in the first kilobyte. */
export function hasPdfSignature(bytes: Uint8Array): boolean {
  const end = Math.min(bytes.length, 1024) - 5
  for (let offset = 0; offset <= end; offset++) {
    if (bytes[offset] === 0x25 && bytes[offset + 1] === 0x50 && bytes[offset + 2] === 0x44 && bytes[offset + 3] === 0x46 && bytes[offset + 4] === 0x2d) return true
  }
  return false
}
