// Runs inside the PDF sandbox frame and nowhere else: an opaque origin with
// its own policy, no network and no bridge. It must not import from the rest
// of the UI; only PDF.js, the line builder and the protocol are bundled with it.
import type { PdfTextPage, PdfTextResult, RecognizedText } from "@once/app"
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs"
import { pdfTextLines } from "./pdfTextLines"
import { HostToPdfSandbox, PDF_SANDBOX_PROTOCOL, PdfAssetKind, readPdfHostMessage } from "./pdfSandboxProtocol"

type PdfPage = import("pdfjs-dist").PDFPageProxy
type TextItem = import("pdfjs-dist/types/src/display/api").TextItem

const MAX_PAGES = 200
/** Rasterization for OCR is bounded to this longest side. */
const MAX_RENDER_PIXELS = 2600

interface Host {
  asset(kind: PdfAssetKind, filename: string): Promise<Uint8Array>
  progress(page: number, total: number): void
  recognize(image: Uint8Array, page: number): Promise<RecognizedText>
}

export function startPdfSandboxRuntime(scope: Window): void {
  const parent = scope.parent
  const post = (message: unknown, transfer: Transferable[] = []) => parent.postMessage(message, "*", transfer)
  const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>()
  let nextRequest = 1
  let started = false

  const request = <T>(message: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const requestId = nextRequest++
      pending.set(requestId, { resolve: value => resolve(value as T), reject })
      post({ ...message, requestId }, transfer)
    })

  const host: Host = {
    async asset(kind, filename) {
      const reply = await request<HostToPdfSandbox & { type: "asset" }>({ type: "asset", kind, filename })
      if (!reply.bytes) throw new Error(reply.error || `Unable to load ${filename}`)
      return reply.bytes
    },
    progress: (page, total) => post({ type: "progress", page, total }),
    async recognize(image, page) {
      const reply = await request<HostToPdfSandbox & { type: "recognized" }>({ type: "recognize", image, page }, [image.buffer])
      if (!reply.result) throw new Error(reply.error || "Image text recognition failed")
      return reply.result
    }
  }

  scope.addEventListener("message", event => {
    if (event.source !== parent) return
    const message = readPdfHostMessage(event.data)
    if (!message) return
    if (message.type === "extract") {
      if (started) return
      started = true
      if (message.protocol !== PDF_SANDBOX_PROTOCOL) {
        post({ type: "error", message: "PDF sandbox protocol mismatch" })
        return
      }
      extract(message.bytes, message.workerSource, message.recognition, host).then(
        result => post({ type: "result", result }),
        error => post({ type: "error", message: error instanceof Error ? error.message : String(error) })
      )
      return
    }
    const waiting = pending.get(message.requestId)
    if (!waiting) return
    pending.delete(message.requestId)
    waiting.resolve(message)
  })
  post({ type: "ready", protocol: PDF_SANDBOX_PROTOCOL })
}

/** Page-by-page extraction: preserve embedded text, OCR only pages without a text layer. */
async function extract(bytes: Uint8Array, workerSource: string, recognition: boolean, host: Host): Promise<PdfTextResult> {
  // The parser's code arrives from the shell, which fetched it from its own
  // origin: the frame's policy forbids loading anything itself. It becomes a
  // blob module; PDF.js starts it as a worker where the host allows one and
  // otherwise imports it onto this frame's own thread (Chromium refuses workers
  // to an opaque origin), which is still outside the shell.
  const workerUrl = URL.createObjectURL(new Blob([workerSource], { type: "text/javascript" }))
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl
  class SandboxBinaryDataFactory {
    fetch({ kind, filename }: { kind: PdfAssetKind; filename: string }): Promise<Uint8Array> {
      return host.asset(kind, filename)
    }
  }
  const task = pdfjs.getDocument({
    data: bytes, useWorkerFetch: false,
    // Encoding maps, standard fonts and image decoders come from the shell on request.
    cMapUrl: "cmaps/", cMapPacked: true, standardFontDataUrl: "standard_fonts/", wasmUrl: "wasm/",
    BinaryDataFactory: SandboxBinaryDataFactory as unknown as undefined,
    isOffscreenCanvasSupported: false, isImageDecoderSupported: false,
    maxImageSize: 16_000_000, enableXfa: false, disableFontFace: true
  })
  try {
    return await readPages()
  } catch (error) {
    if (error instanceof Error && error.name === "PasswordException") throw new Error("This PDF is password-protected. Open an unlocked copy in Reader.")
    throw error
  } finally {
    await task.destroy().catch(() => undefined)
    URL.revokeObjectURL(workerUrl)
  }

  async function readPages(): Promise<PdfTextResult> {
    const pdf = await task.promise
    if (pdf.numPages > MAX_PAGES) throw new Error(`PDF has too many pages (maximum ${MAX_PAGES})`)
    const metadata = await pdf.getMetadata().catch(() => null)
    const title = (metadata?.info as { Title?: unknown } | undefined)?.Title
    const pages: PdfTextPage[] = []
    for (let number = 1; number <= pdf.numPages; number++) {
      host.progress(number, pdf.numPages)
      const page = await pdf.getPage(number)
      try {
        const viewport = page.getViewport({ scale: 1 })
        const text = pdfTextLines(await textItems(page), matrix => pdfjs.Util.transform(viewport.transform, matrix))
        if (text.lines.some(line => /[\p{L}\p{N}]/u.test(line))) { pages.push({ ...text, method: "embedded" }); continue }
        const image = await renderPage(page)
        if (!image) { pages.push({ lines: [], method: "embedded" }); continue }
        if (!recognition) throw new Error(`PDF page ${number} has no embedded text. OCR is not available on this platform yet.`)
        const recognized = await host.recognize(image, number)
        if (!recognized.lines.some(line => line.trim())) throw new Error(`No text could be recognized on PDF page ${number}`)
        pages.push({ ...recognized, method: "ocr" })
      } finally { page.cleanup() }
    }
    return { pages, ...(typeof title === "string" && title.trim() ? { title: title.trim().slice(0, 512) } : {}) }
  }
}

/** The page's text runs; read with a reader because WebKit cannot iterate a stream with `for await`, which `getTextContent` does. */
async function textItems(page: PdfPage): Promise<TextItem[]> {
  const reader = page.streamTextContent().getReader()
  const items: TextItem[] = []
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    for (const item of value.items) if ("str" in item) items.push(item)
  }
  return items
}

/** Rasterizes a page once; a uniform (blank) bitmap yields null instead of an image for OCR. */
async function renderPage(page: PdfPage): Promise<Uint8Array | null> {
  const base = page.getViewport({ scale: 1 })
  const scale = Math.min(2.5, MAX_RENDER_PIXELS / Math.max(base.width, base.height))
  const viewport = page.getViewport({ scale })
  const canvas = document.createElement("canvas")
  canvas.width = Math.ceil(viewport.width); canvas.height = Math.ceil(viewport.height)
  try {
    // Annotations are not page content, and their appearance streams need not
    // be parsed. The print intent continues rendering with microtasks rather
    // than animation frames, which a hidden frame never receives.
    await page.render({ canvas, viewport, background: "rgb(255,255,255)", intent: "print", annotationMode: pdfjs.AnnotationMode.DISABLE }).promise
    if (blank(canvas)) return null
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("PDF page could not be rendered")), "image/png"))
    return new Uint8Array(await blob.arrayBuffer())
  } finally { canvas.width = canvas.height = 0 }
}

function blank(canvas: HTMLCanvasElement): boolean {
  const context = canvas.getContext("2d", { willReadFrequently: true })
  if (!context || !canvas.width || !canvas.height) return true
  const { data } = context.getImageData(0, 0, canvas.width, canvas.height)
  const [r, g, b] = data
  for (let offset = 0; offset < data.length; offset += 4) {
    if (Math.abs(data[offset] - r) > 8 || Math.abs(data[offset + 1] - g) > 8 || Math.abs(data[offset + 2] - b) > 8) return false
  }
  return true
}
