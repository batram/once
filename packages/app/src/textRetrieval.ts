import { readResponseBytes } from "./responseBytes"
import { ocrParagraphs, TextLineBounds } from "./ocrParagraphs"

/** Extracted lines in reading order, independent of the text extraction engine. */
export interface RecognizedText {
  /** Explicit paragraphs supplied by a recognition backend, without invented bounds. */
  paragraphs?: string[]
  lines: string[]
  /** Optional bounds aligned with lines, in a common image coordinate system. */
  lineBounds?: TextLineBounds[]
}

/** Implement on platforms with OCR. Image bytes never leave the device. */
export interface TextRecognitionPort {
  recognizeImage(bytes: Uint8Array, signal?: AbortSignal): Promise<RecognizedText>
}

export interface DocumentRecognitionOptions {
  signal?: AbortSignal
  onPage?(page: number, total: number): void
  /** Also render the first this-many PDF pages as JPEG pictures; a pictured page needs no OCR. */
  pageImages?: number
  onPageImage?(page: number, image: Uint8Array): void
  /**
   * Reads PDF pages `from` to `to` only. With `onlyIfScanned`, the window applies only when page
   * `from` has no embedded text, so a long scan is read in parts while a text PDF is read whole.
   */
  pages?: { from: number; to: number; onlyIfScanned?: boolean }
}

/** HTML remains intact for article extraction; OCR is plain text, never markup. */
export type RetrievedDocument =
  | { kind: "html"; html: string; url: string; mediaType: string }
  | { kind: "text"; text: string; lines: string[]; paragraphs: string[]; url: string; mediaType: string; method: "ocr" | "embedded" | "mixed"; title?: string; pages?: import("@once/core").ReaderPages }

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024

export async function recognizeResponse(response: Response, recognition: TextRecognitionPort | undefined): Promise<RecognizedText> {
  if (!recognition) throw new Error("Image text recognition is not available on this platform yet")
  const result = await recognition.recognizeImage(await readResponseBytes(response, MAX_IMAGE_BYTES, "Image"))
  const lines = result.lines.map(line => line.trim()).filter(Boolean)
  if (!lines.length) throw new Error("No text was found in this image")
  return { lines, paragraphs: result.paragraphs, lineBounds: result.lineBounds?.filter((_, index) => result.lines[index].trim()) }
}

/** Adapt plain text for existing reader/storage consumers without interpreting OCR as HTML. */
export function documentHtml(document: RetrievedDocument): string {
  if (document.kind === "html") return document.html
  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char] ?? char)
  return `<!doctype html><html><head><title>${escape(document.title || new URL(document.url).pathname.split("/").pop() || "Document text")}</title></head><body><article>${document.paragraphs.map(paragraph => `<p>${escape(paragraph)}</p>`).join("")}</article></body></html>`
}

export function recognizedDocument(result: RecognizedText, url: string, mediaType: string): RetrievedDocument {
  const paragraphs = ocrParagraphs(result)
  return { kind: "text", text: paragraphs.join("\n\n"), lines: result.lines, paragraphs, url, mediaType, method: "ocr" }
}
