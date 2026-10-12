import type { PdfTextPort, PdfTextResult, TextRecognitionPort, DocumentRecognitionOptions } from "@once/app"
import { PDF_SANDBOX_LIMITS, PDF_SANDBOX_PROTOCOL, PdfAssetKind, readPdfSandboxMessage } from "./pdfSandboxProtocol"

export interface PdfTextPortOptions {
  /** The packaged sandbox page (`pdf-sandbox.html`), loaded in a sandboxed frame. */
  sandboxUrl: string
  /** The parser worker's script and the directory of its assets (`cmaps/`, …); the bundled worker's location by default. */
  workerUrl?: string
  assetsUrl?: string
  /** Overall extraction deadline. */
  timeoutMs?: number
  /** The frame's document and the window its messages arrive on; the page's by default. */
  document?: Document
  window?: Window
}

const ASSET_DIRECTORIES: Record<PdfAssetKind, string> = { cMapUrl: "cmaps/", standardFontDataUrl: "standard_fonts/", wasmUrl: "wasm/" }
const DEFAULT_TIMEOUT_MS = 120_000
const READY_TIMEOUT_MS = 15_000

/**
 * PDF.js runs in a hidden `<iframe sandbox="allow-scripts">` on an opaque
 * origin: no network, no storage, no bridge, nothing of the shell's. The shell
 * hands it the bytes and the worker's code, answers its requests for encoding
 * maps, fonts and decoders from its own origin, runs OCR on the bitmaps it
 * sends back, and validates every message. A fresh frame serves each PDF and
 * is removed afterwards.
 */
export function createPdfTextPort(options: PdfTextPortOptions): PdfTextPort {
  let worker: Promise<{ source: string; assets: string }> | undefined
  return {
    extract(bytes, recognition, job) {
      worker ??= loadWorker(options).catch(error => { worker = undefined; throw error })
      return extractInSandbox(bytes, recognition, options, worker, job)
    }
  }
}

/** The bundled worker is an emitted asset; its location is only known to the bundle, so it is resolved on first use. */
async function loadWorker(options: PdfTextPortOptions): Promise<{ source: string; assets: string }> {
  const workerUrl = new URL(options.workerUrl ?? (await import(/* webpackMode: "eager" */ "./pdfWorkerAsset.js")).pdfWorkerUrl, location.href).href
  const assets = options.assetsUrl ?? new URL("./", workerUrl).href
  return { source: await loadText(workerUrl), assets }
}

async function extractInSandbox(
  bytes: Uint8Array,
  recognition: TextRecognitionPort | undefined,
  options: PdfTextPortOptions,
  worker: Promise<{ source: string; assets: string }>,
  job?: DocumentRecognitionOptions
): Promise<PdfTextResult> {
  const doc = options.document ?? document
  const scope = options.window ?? window
  job?.signal?.throwIfAborted()
  const { source, assets } = await worker
  job?.signal?.throwIfAborted()
  const frame = doc.createElement("iframe")
  frame.setAttribute("sandbox", "allow-scripts")
  frame.hidden = true
  frame.title = "PDF sandbox"
  frame.dataset.pdfSandbox = "1"
  const post = (message: unknown, transfer: Transferable[] = []) => frame.contentWindow?.postMessage(message, "*", transfer)

  return new Promise<PdfTextResult>((resolve, reject) => {
    let settled = false
    const finish = (error?: Error, result?: PdfTextResult) => {
      if (settled) return
      settled = true
      clearTimeout(deadline); clearTimeout(readyDeadline)
      scope.removeEventListener("message", onMessage)
      job?.signal?.removeEventListener("abort", aborted)
      frame.remove()
      if (error) reject(error); else resolve(result as PdfTextResult)
    }
    const expire = () => finish(new Error("PDF text extraction timed out"))
    let deadline = setTimeout(expire, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    const aborted = () => finish(new Error("PDF extraction cancelled"))
    let readyDeadline: ReturnType<typeof setTimeout> | undefined = setTimeout(() => finish(new Error("PDF sandbox did not start")), READY_TIMEOUT_MS)

    const onMessage = (event: MessageEvent) => {
      if (!frame.contentWindow || event.source !== frame.contentWindow) return
      const message = readPdfSandboxMessage(event.data)
      if (!message) return
      if (job?.cloud) { clearTimeout(deadline); deadline = setTimeout(expire, 150_000) }
      switch (message.type) {
        case "ready": {
          clearTimeout(readyDeadline); readyDeadline = undefined
          if (message.protocol !== PDF_SANDBOX_PROTOCOL) { finish(new Error("PDF sandbox protocol mismatch")); return }
          const copy = bytes.slice()
          post({ type: "extract", protocol: PDF_SANDBOX_PROTOCOL, bytes: copy, workerSource: source, recognition: Boolean(recognition || job?.cloud) }, [copy.buffer])
          return
        }
        case "progress":
          job?.onPage?.(message.page, message.total)
          return
        case "asset":
          void loadBytes(`${assets}${ASSET_DIRECTORIES[message.kind]}${message.filename}`, PDF_SANDBOX_LIMITS.assetBytes).then(
            loaded => post({ type: "asset", requestId: message.requestId, bytes: loaded }, [loaded.buffer]),
            (error: unknown) => post({ type: "asset", requestId: message.requestId, error: error instanceof Error ? error.message : String(error) })
          )
          return
        case "recognize":
          if (!recognition && !job?.cloud) { post({ type: "recognized", requestId: message.requestId, error: "Image text recognition is not available on this platform yet" }); return }
          void (job?.cloud?.recognizeImage(message.image, message.page) ?? recognition?.recognizeImage(message.image))?.then(
            result => post({ type: "recognized", requestId: message.requestId, result }),
            (error: unknown) => post({ type: "recognized", requestId: message.requestId, error: error instanceof Error ? error.message : String(error) })
          )
          return
        case "result":
          finish(undefined, message.result)
          return
        case "error":
          finish(new Error(message.message))
      }
    }
    job?.signal?.addEventListener("abort", aborted, { once: true })
    if (job?.signal?.aborted) { aborted(); return }
    scope.addEventListener("message", onMessage)
    frame.src = options.sandboxUrl
    doc.body.append(frame)
  })
}

/** Reads a same-origin file; `fetch` refuses `file:` (packaged Electron), where XHR still serves the shell's own files. */
async function loadBytes(url: string, limit?: number): Promise<Uint8Array> {
  if (/^https?:|^[a-z-]+-extension:|^capacitor:/i.test(url)) {
    const response = await fetch(url)
    if (!response.ok) throw new Error(`Unable to load ${url}: ${response.status}`)
    if (!limit) return new Uint8Array(await response.arrayBuffer())
    const length = Number(response.headers?.get("content-length"))
    if (length > limit) { await response.body?.cancel(); throw new Error("PDF asset too large") }
    if (!response.body) {
      const bytes = new Uint8Array(await response.arrayBuffer())
      if (bytes.byteLength > limit) throw new Error("PDF asset too large")
      return bytes
    }
    const reader = response.body.getReader()
    const chunks: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > limit) throw new Error("PDF asset too large")
        chunks.push(value)
      }
    } finally { await reader.cancel() }
    const bytes = new Uint8Array(size)
    let offset = 0
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength }
    return bytes
  }
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open("GET", url, true)
    request.responseType = "arraybuffer"
    if (limit) request.onprogress = event => {
      if (event.loaded > limit) { request.abort(); reject(new Error("PDF asset too large")) }
    }
    request.onload = () => {
      if (request.status !== 200 && request.status !== 0) { reject(new Error(`Unable to load ${url}: ${request.status}`)); return }
      const bytes = new Uint8Array(request.response as ArrayBuffer)
      if (limit && bytes.byteLength > limit) reject(new Error("PDF asset too large"))
      else resolve(bytes)
    }
    request.onerror = () => reject(new Error(`Unable to load ${url}`))
    request.send()
  })
}

async function loadText(url: string): Promise<string> {
  return new TextDecoder().decode(await loadBytes(url))
}
