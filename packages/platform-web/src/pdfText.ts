import type { PdfTextPort } from "@once/app"

/** Load PDF.js only when a PDF is requested; no PDF code runs in ordinary page retrieval. */
export function createPdfTextPort(): PdfTextPort {
  return {
    async extract(bytes, recognition) {
      const { extractPdf } = await import(/* webpackMode: "eager" */ "./pdfjs.js")
      return extractPdf(bytes, recognition)
    }
  }
}
