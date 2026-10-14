// PROTOTYPE, not for shipping: Datalab's Indra OCR (a JS port on a reduced
// ONNX Runtime WASM build) as an alternative to the native helper, behind the
// "Indra OCR (test)" setting. Its files are assembled locally into
// apps/electron/indra-proto/ (git-excluded; see benchmarks/ocr/indra-js/proto)
// and run in a utility process, which is stopped after a minute idle so its
// memory goes back to the system.
import { ELECTRON_IPC } from "@once/platform-electron/bridge"
import { app, ipcMain, nativeImage, utilityProcess, type IpcMainInvokeEvent, type UtilityProcess } from "electron"
import { existsSync } from "node:fs"
import path from "node:path"
import type { ImageTextResult } from "@once/ui-web/imageText/imageTextTypes"
import type { SecureSettings } from "../SecureSettings"

const IDLE_MS = 60_000
/** Like the native helpers' thumbnail: recognition never reads more than this. */
const MAX_SIDE = 4096

let enabled = false
let worker: { process: UtilityProcess; ready: Promise<void> } | null = null
let idleTimer: NodeJS.Timeout | undefined
let nextId = 0
const pending = new Map<number, { resolve: (result: ImageTextResult) => void; reject: (error: Error) => void }>()

const protoDirectory = () => app.isPackaged
  ? path.join(process.resourcesPath, "indra-proto")
  : path.resolve(__dirname, "../../../indra-proto")

export const indraOcrEnabled = () => enabled
const indraOcrInstalled = () => existsSync(path.join(protoDirectory(), "worker.mjs"))

function stopWorker(): void {
  worker?.process.kill()
  worker = null
}

function startWorker(): { process: UtilityProcess; ready: Promise<void> } {
  const child = utilityProcess.fork(path.join(protoDirectory(), "worker.mjs"), [], { serviceName: "Once Indra OCR (prototype)" })
  const ready = new Promise<void>((resolve, reject) => {
    child.on("message", (message: { ready?: boolean; loadMs?: number; id?: number; result?: ImageTextResult; error?: string; ms?: number }) => {
      if (message.ready) { console.log(`Indra OCR: engine loaded in ${message.loadMs} ms`); resolve(); return }
      const job = message.id === undefined ? undefined : pending.get(message.id)
      if (!job || message.id === undefined) return
      pending.delete(message.id)
      if (message.error || !message.result) job.reject(new Error(message.error ?? "Indra OCR failed"))
      else { console.log(`Indra OCR: ${message.result.textLines.length} lines in ${message.ms} ms`); job.resolve(message.result) }
    })
    child.once("exit", (code) => {
      reject(new Error(`Indra OCR process exited (${code})`))
      for (const job of pending.values()) job.reject(new Error(`Indra OCR process exited (${code})`))
      pending.clear()
      if (worker?.process === child) worker = null
    })
  })
  return { process: child, ready }
}

/** Grey page (cv2 BT.601 weights) from encoded bytes, at most MAX_SIDE; null when nativeImage cannot decode it. */
function decodeGray(bytes: Buffer): { data: Uint8Array; width: number; height: number } | null {
  let image = nativeImage.createFromBuffer(bytes)
  if (image.isEmpty()) return null
  let { width, height } = image.getSize()
  if (Math.max(width, height) > MAX_SIDE) {
    const scale = MAX_SIDE / Math.max(width, height)
    image = image.resize({ width: Math.round(width * scale), height: Math.round(height * scale), quality: "best" })
    ;({ width, height } = image.getSize())
  }
  // toBitmap() is BGRA on Windows and macOS.
  const bgra = image.toBitmap()
  const data = new Uint8Array(width * height)
  for (let i = 0, j = 0; i < data.length; i++, j += 4) data[i] = (bgra[j + 2] * 4899 + bgra[j + 1] * 9617 + bgra[j] * 1868 + 8192) >> 14
  return { data, width, height }
}

/** Indra's reading of the image, or null when the prototype cannot take it (not installed, undecodable). */
export async function recognizeWithIndra(bytes: Buffer, signal: AbortSignal): Promise<ImageTextResult | null> {
  if (!indraOcrInstalled()) { console.warn("Indra OCR: prototype files missing in", protoDirectory()); return null }
  const page = decodeGray(bytes)
  if (!page) { console.warn("Indra OCR: image format not decodable by nativeImage; using the native engine"); return null }
  clearTimeout(idleTimer)
  worker ??= startWorker()
  const { process: child, ready } = worker
  await ready
  signal.throwIfAborted()
  const id = nextId++
  try {
    return await new Promise<ImageTextResult>((resolve, reject) => {
      pending.set(id, { resolve, reject })
      signal.addEventListener("abort", () => { pending.delete(id); reject(signal.reason) }, { once: true })
      child.postMessage({ id, width: page.width, height: page.height, data: page.data })
    })
  } finally {
    if (!pending.size) idleTimer = setTimeout(stopWorker, IDLE_MS)
  }
}

/** Reads the setting at startup and serves the settings switch. */
export function registerIndraOcrSetting(settings: SecureSettings, trusted: (event: IpcMainInvokeEvent) => void): void {
  const loaded = settings.getIndraOcr().then((value) => { enabled = value }, () => undefined)
  ipcMain.handle(ELECTRON_IPC.getIndraOcr, async (event) => {
    trusted(event)
    await loaded
    return { enabled, installed: indraOcrInstalled() }
  })
  ipcMain.handle(ELECTRON_IPC.setIndraOcr, async (event, value: unknown) => {
    trusted(event)
    if (typeof value !== "boolean") throw new Error("Invalid Indra OCR flag")
    await settings.setIndraOcr(value)
    enabled = value
    if (!value) stopWorker()
  })
}
