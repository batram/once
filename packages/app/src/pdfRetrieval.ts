import { ocrParagraphs } from "./ocrParagraphs"
import type { RecognizedText, RetrievedDocument, TextRecognitionPort } from "./textRetrieval"
import { MAX_DOCUMENT_BYTES, readResponseBytes } from "./responseBytes"

export interface PdfTextPage extends RecognizedText { method: "embedded" | "ocr" }
export interface PdfTextResult { pages: PdfTextPage[]; title?: string }
/** A platform may use PDF.js, PDFKit or another local PDF engine. Pages remain ordered. */
export interface PdfTextPort {
  extract(bytes: Uint8Array, recognition?: TextRecognitionPort): Promise<PdfTextResult>
}

export async function retrievePdf(response: Response, url: string, pdf: PdfTextPort | undefined, recognition?: TextRecognitionPort): Promise<RetrievedDocument> {
  if (!pdf) throw new Error("PDF text extraction is not available on this platform")
  const bytes = await readResponseBytes(response, MAX_DOCUMENT_BYTES, "PDF")
  const result = await pdf.extract(bytes, recognition)
  const paragraphs = result.pages.flatMap(page => ocrParagraphs(page))
  const lines = result.pages.flatMap(page => page.lines)
  if (!paragraphs.length) throw new Error("No readable text was found in this PDF")
  const used = new Set(result.pages.filter(page => page.lines.some(line => line.trim())).map(page => page.method))
  const method = used.size > 1 ? "mixed" : used.has("ocr") ? "ocr" : "embedded"
  return { kind: "text", text: paragraphs.join("\n\n"), lines, paragraphs, url, mediaType: "application/pdf", method, title: result.title }
}
