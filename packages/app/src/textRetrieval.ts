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
  recognizeImage(bytes: Uint8Array): Promise<RecognizedText>
}

/** Used only by explicit cloud OCR actions; never substituted for device-local OCR. */
export interface CloudTextRecognitionPort {
  recognizeImage(bytes: Uint8Array, page?: number): Promise<RecognizedText>
}
export interface DocumentRecognitionOptions {
  signal?: AbortSignal
  cloud?: CloudTextRecognitionPort
  onPage?(page: number, total: number): void
}

/** HTML remains intact for article extraction; OCR is plain text, never markup. */
export type RetrievedDocument =
  | { kind: "html"; html: string; url: string; mediaType: string }
  | { kind: "text"; text: string; lines: string[]; paragraphs: string[]; url: string; mediaType: string; method: "ocr" | "ai-ocr" | "embedded" | "mixed"; title?: string; ai?: import("@once/core").AiProvenance }

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024

export async function recognizeResponse(response: Response, recognition: TextRecognitionPort | undefined, cloud?: CloudTextRecognitionPort): Promise<RecognizedText> {
  if (!recognition && !cloud) throw new Error("Image text recognition is not available on this platform yet")
  const bytes = await readResponseBytes(response, MAX_IMAGE_BYTES, "Image")
  const result = await (cloud ?? recognition)?.recognizeImage(bytes)
  if (!result) throw new Error("No recognition backend")
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
