import { ocrParagraphs, TextLineBounds } from "./ocrParagraphs"

/** Recognized lines in reading order, independent of the native OCR engine. */
export interface RecognizedText {
  lines: string[]
  /** Optional bounds aligned with lines, in a common image coordinate system. */
  lineBounds?: TextLineBounds[]
}

/** Implement on platforms with OCR. Image bytes never leave the device. */
export interface TextRecognitionPort {
  recognizeImage(bytes: Uint8Array): Promise<RecognizedText>
}

/** HTML remains intact for article extraction; OCR is plain text, never markup. */
export type RetrievedDocument =
  | { kind: "html"; html: string; url: string; mediaType: string }
  | { kind: "text"; text: string; lines: string[]; paragraphs: string[]; url: string; mediaType: string; method: "ocr" }

export const MAX_IMAGE_BYTES = 32 * 1024 * 1024

export async function recognizeResponse(response: Response, recognition: TextRecognitionPort | undefined): Promise<RecognizedText> {
  if (!recognition) throw new Error("Image text recognition is not available on this platform yet")
  if (Number(response.headers.get("content-length")) > MAX_IMAGE_BYTES) throw new Error("Image too large")
  if (!response.body) throw new Error("Image unavailable")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_IMAGE_BYTES) throw new Error("Image too large")
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const bytes = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
  const result = await recognition.recognizeImage(bytes)
  const lines = result.lines.map(line => line.trim()).filter(Boolean)
  if (!lines.length) throw new Error("No text was found in this image")
  return { lines, lineBounds: result.lineBounds?.filter((_, index) => result.lines[index].trim()) }
}

/** Adapt plain text for existing reader/storage consumers without interpreting OCR as HTML. */
export function documentHtml(document: RetrievedDocument): string {
  if (document.kind === "html") return document.html
  const escape = (text: string) => text.replace(/[&<>"']/g, char => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  })[char] ?? char)
  return `<!doctype html><html><head><title>${escape(new URL(document.url).pathname.split("/").pop() || "Image text")}</title></head><body><article>${document.paragraphs.map(paragraph => `<p>${escape(paragraph)}</p>`).join("")}</article></body></html>`
}

export function recognizedDocument(result: RecognizedText, url: string, mediaType: string): RetrievedDocument {
  const paragraphs = ocrParagraphs(result)
  return { kind: "text", text: paragraphs.join("\n\n"), lines: result.lines, paragraphs, url, mediaType, method: "ocr" }
}
