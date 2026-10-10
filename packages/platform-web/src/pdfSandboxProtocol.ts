import type { PdfTextPage, PdfTextResult, RecognizedText } from "@once/app"

/**
 * The conversation between the shell and the PDF sandbox frame. The frame
 * runs PDF.js on an opaque origin with no network and nothing of the shell's;
 * everything it sends back is validated here before the shell uses it, so a
 * compromised parser can at most return wrong text.
 */
export const PDF_SANDBOX_PROTOCOL = 1

export const PDF_SANDBOX_LIMITS = {
  /** Pages an extraction result may contain. */
  pages: 200,
  /** Lines per page and characters per line that survive validation. */
  linesPerPage: 20_000,
  lineLength: 10_000,
  title: 512,
  /** A rendered page handed to OCR, and a cmap/font/wasm asset handed to the frame. */
  imageBytes: 32 * 1024 * 1024,
  assetBytes: 32 * 1024 * 1024,
  error: 2000
}

export type PdfAssetKind = "cMapUrl" | "standardFontDataUrl" | "wasmUrl"

export type HostToPdfSandbox =
  | { type: "extract"; protocol: number; bytes: Uint8Array; workerSource: string; recognition: boolean }
  | { type: "asset"; requestId: number; bytes?: Uint8Array; error?: string }
  | { type: "recognized"; requestId: number; result?: RecognizedText; error?: string }

export type PdfSandboxToHost =
  | { type: "ready"; protocol: number }
  | { type: "asset"; requestId: number; kind: PdfAssetKind; filename: string }
  | { type: "recognize"; requestId: number; image: Uint8Array }
  | { type: "result"; result: PdfTextResult }
  | { type: "error"; message: string }

const ASSET_KINDS = new Set<PdfAssetKind>(["cMapUrl", "standardFontDataUrl", "wasmUrl"])
const ASSET_FILENAME = /^[A-Za-z0-9][\w-]*(?:\.[\w-]+)*$/

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value)
}

function page(value: unknown): PdfTextPage | null {
  if (!record(value) || !Array.isArray(value.lines) || value.lines.length > PDF_SANDBOX_LIMITS.linesPerPage) return null
  if (value.method !== "embedded" && value.method !== "ocr") return null
  const lines: string[] = []
  for (const line of value.lines) {
    if (typeof line !== "string") return null
    lines.push(line.slice(0, PDF_SANDBOX_LIMITS.lineLength))
  }
  let lineBounds: RecognizedText["lineBounds"]
  if (value.lineBounds !== undefined) {
    if (!Array.isArray(value.lineBounds) || value.lineBounds.length !== lines.length) return null
    lineBounds = []
    for (const box of value.lineBounds) {
      if (!record(box) || !finite(box.x) || !finite(box.y) || !finite(box.width) || !finite(box.height)) return null
      lineBounds.push({ x: box.x, y: box.y, width: box.width, height: box.height })
    }
  }
  return { lines, method: value.method, ...(lineBounds ? { lineBounds } : {}) }
}

/** Validates a message from the frame; anything malformed is dropped. */
export function readPdfSandboxMessage(value: unknown): PdfSandboxToHost | null {
  if (!record(value)) return null
  switch (value.type) {
    case "ready":
      return finite(value.protocol) ? { type: "ready", protocol: value.protocol } : null
    case "asset":
      if (!finite(value.requestId) || typeof value.kind !== "string" || !ASSET_KINDS.has(value.kind as PdfAssetKind)) return null
      if (typeof value.filename !== "string" || !ASSET_FILENAME.test(value.filename) || value.filename.length > 128) return null
      return { type: "asset", requestId: value.requestId, kind: value.kind as PdfAssetKind, filename: value.filename }
    case "recognize":
      if (!finite(value.requestId) || !(value.image instanceof Uint8Array)) return null
      if (!value.image.byteLength || value.image.byteLength > PDF_SANDBOX_LIMITS.imageBytes) return null
      return { type: "recognize", requestId: value.requestId, image: value.image }
    case "result": {
      if (!record(value.result) || !Array.isArray(value.result.pages) || value.result.pages.length > PDF_SANDBOX_LIMITS.pages) return null
      const pages: PdfTextPage[] = []
      for (const candidate of value.result.pages) {
        const validated = page(candidate)
        if (!validated) return null
        pages.push(validated)
      }
      const title = typeof value.result.title === "string" ? value.result.title.slice(0, PDF_SANDBOX_LIMITS.title) : undefined
      return { type: "result", result: { pages, ...(title ? { title } : {}) } }
    }
    case "error":
      return { type: "error", message: typeof value.message === "string" ? value.message.slice(0, PDF_SANDBOX_LIMITS.error) : "PDF text extraction failed" }
    default:
      return null
  }
}

/** Validates a reply from the host inside the frame, which trusts only its parent. */
export function readPdfHostMessage(value: unknown): HostToPdfSandbox | null {
  if (!record(value)) return null
  switch (value.type) {
    case "extract":
      if (!finite(value.protocol) || !(value.bytes instanceof Uint8Array) || typeof value.workerSource !== "string") return null
      return { type: "extract", protocol: value.protocol, bytes: value.bytes, workerSource: value.workerSource, recognition: value.recognition === true }
    case "asset":
      if (!finite(value.requestId)) return null
      return { type: "asset", requestId: value.requestId, ...(value.bytes instanceof Uint8Array ? { bytes: value.bytes } : {}), ...(typeof value.error === "string" ? { error: value.error } : {}) }
    case "recognized": {
      if (!finite(value.requestId)) return null
      const result = record(value.result) && Array.isArray(value.result.lines) ? value.result as unknown as RecognizedText : undefined
      return { type: "recognized", requestId: value.requestId, ...(result ? { result } : {}), ...(typeof value.error === "string" ? { error: value.error } : {}) }
    }
    default:
      return null
  }
}
