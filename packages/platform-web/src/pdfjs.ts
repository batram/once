import type { PdfTextResult, PdfTextPage, TextRecognitionPort } from "@once/app"
import workerUrl from "pdfjs-dist/legacy/build/pdf.worker.min.mjs?pdf-worker"
import { pdfTextLines } from "./pdfTextLines"

type PdfPage = import("pdfjs-dist").PDFPageProxy

async function recognizePage(page: PdfPage, recognition: TextRecognitionPort): Promise<PdfTextPage> {
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(2.5, 2600 / Math.max(base.width, base.height))
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement("canvas")
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
  try {
    await page.render({ canvas, viewport, background: "rgb(255,255,255)" }).promise
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("PDF page could not be rendered")), "image/png"))
    const result = await recognition.recognizeImage(new Uint8Array(await blob.arrayBuffer()))
    return { ...result, method: "ocr" }
  } finally { canvas.width = canvas.height = 0 }
}

/** Page-by-page extraction: preserve embedded text, OCR only pages without a text layer. */
export async function extractPdf(bytes: Uint8Array, recognition?: TextRecognitionPort): Promise<PdfTextResult> {
  const pdfjs = await import(/* webpackMode: "eager" */ "pdfjs-dist/legacy/build/pdf.mjs")
  const worker = new Worker(workerUrl, { type: "module" })
  const pdfWorker = pdfjs.PDFWorker.create({ port: worker })
  const assets = new URL("./", new URL(workerUrl, location.href)).href
  const task = pdfjs.getDocument({
    data: bytes, worker: pdfWorker, useWorkerFetch: false,
    cMapUrl: `${assets}cmaps/`, standardFontDataUrl: `${assets}standard_fonts/`, wasmUrl: `${assets}wasm/`,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    maxImageSize: 16_000_000, enableXfa: false, disableFontFace: true
  })
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    const timeout = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("PDF text extraction timed out")), 120_000) })
    return await Promise.race([readPages(), timeout])
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") throw new Error("This PDF is password-protected. Open an unlocked copy in Reader.")
    throw error
  } finally {
    clearTimeout(timer)
    await task.destroy().catch(() => undefined)
    pdfWorker.destroy(); worker.terminate()
  }

  async function readPages(): Promise<PdfTextResult> {
    const pdf = await task.promise
    if (pdf.numPages > 200) throw new Error("PDF has too many pages (maximum 200)")
    const metadata = await pdf.getMetadata().catch(() => null)
    const title = (metadata?.info as { Title?: unknown } | undefined)?.Title
    const pages: PdfTextPage[] = []
    for (let number = 1; number <= pdf.numPages; number++) {
      const page = await pdf.getPage(number)
      try {
        const viewport = page.getViewport({ scale: 1 })
        const content = await page.getTextContent()
        const text = pdfTextLines(content.items.filter((item): item is import("pdfjs-dist/types/src/display/api").TextItem => "str" in item), matrix => pdfjs.Util.transform(viewport.transform, matrix))
        if (text.lines.some(line => /[\p{L}\p{N}]/u.test(line))) pages.push({ ...text, method: "embedded" })
        else if (!(await page.getOperatorList()).fnArray.length) pages.push({ lines: [], method: "embedded" })
        else {
          if (!recognition) throw new Error(`PDF page ${number} has no embedded text. OCR is not available on this platform yet.`)
          const recognized = await recognizePage(page, recognition)
          if (!recognized.lines.some(line => line.trim())) throw new Error(`No text could be recognized on PDF page ${number}`)
          pages.push(recognized)
        }
      } finally { page.cleanup() }
    }
    return { pages, ...(typeof title === "string" && title.trim() ? { title: title.trim().slice(0, 512) } : {}) }
  }
}
