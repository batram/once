import { ELECTRON_IPC } from "@once/platform-electron/bridge"
import { app, ipcMain, type IpcMainInvokeEvent, type WebContents } from "electron"
import { spawn } from "node:child_process"
import { promises as fs } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { ImageTextResult } from "@once/ui-web/imageText/imageTextTypes"
import { indraOcrEnabled, recognizeWithIndra } from "./IndraTextRecognition"
import { OcrQueue } from "./OcrQueue"
import { readOcrResult } from "./ocrResult"

const MAX_BYTES = 32 * 1024 * 1024
const queue = new OcrQueue()

/** Platforms with a native helper: Apple Vision (macOS) and Windows.Media.Ocr (Windows). */
export const nativeTextRecognitionAvailable = process.platform === "darwin" || process.platform === "win32"

/** Shared native OCR backend for image selection and document retrieval. */
export async function recognize(bytes: Buffer, signal: AbortSignal): Promise<ImageTextResult> {
  if (!bytes.length || bytes.length > MAX_BYTES) throw new Error("Invalid image size")
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(20_000)])
  // PROTOTYPE: the "Indra OCR (test)" setting; falls back to the native helper.
  if (indraOcrEnabled()) {
    try {
      const result = await recognizeWithIndra(bytes, deadline)
      if (result) return result
    } catch (error) {
      if (deadline.aborted) throw error
      console.warn("Indra OCR failed; using the native engine", error instanceof Error ? error.message : String(error))
    }
  }
  if (!nativeTextRecognitionAvailable) throw new Error("Image text recognition is not available on this platform yet")
  // The helper decodes the image itself, in its sandbox (ImageTextSandbox.h on Windows, the App Sandbox on macOS).
  return queue.run(deadline, () => recognizeInHelper(bytes, deadline))
}

async function recognizeInHelper(bytes: Buffer, signal: AbortSignal): Promise<ImageTextResult> {
  const name = process.platform === "win32" ? "once-image-text.exe" : "once-image-text"
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.resolve(__dirname, "../../../.native", name)
  signal.throwIfAborted()
  const directory = process.platform === "win32" ? await fs.mkdtemp(path.join(tmpdir(), "once-ocr-")) : null
  try { return await new Promise<ImageTextResult>((resolve, reject) => {
    signal.throwIfAborted()
    const child = spawn(executable, directory ? ["--sandbox-directory", directory] : [], { stdio: ["pipe", "pipe", "pipe"], signal, windowsHide: true })
    let output = ""
    let failure: Error | undefined
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      if (failure) return
      if (output.length + chunk.length > 4 * 1024 * 1024) { failure = new Error("Recognition output too large"); output = ""; child.kill(); return }
      output += chunk
    })
    child.stderr.resume()
    child.stdin.on("error", () => undefined)
    child.on("error", error => { failure = error })
    child.on("close", (code) => {
      if (failure) { reject(failure); return }
      if (signal.aborted) { reject(signal.reason); return }
      if (code !== 0) { reject(new Error("Native recognition failed")); return }
      try { resolve(readOcrResult(JSON.parse(output))) } catch (error) { reject(error) }
    })
    child.stdin.end(bytes)
  }) } finally {
    // The broker also cleans up normally. Main owns cancellation cleanup after the
    // kill-on-close job terminates its worker; never recursively delete a temp tree.
    if (directory) for (let attempt = 0; attempt < 10; attempt++) {
      try {
        await fs.unlink(path.join(directory, "once-image-text.exe")).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error })
        await fs.rmdir(directory).catch((error: NodeJS.ErrnoException) => { if (error.code !== "ENOENT") throw error })
        break
      } catch (error) {
        if (attempt === 9) console.warn("Could not remove the OCR sandbox's temporary executable", error instanceof Error ? error.message : String(error))
        else await new Promise(resolve => setTimeout(resolve, 100))
      }
    }
  }
}

export function registerTextRecognition(trusted: (event: IpcMainInvokeEvent) => void): void {
  const jobs = new WeakMap<WebContents, Map<string, AbortController>>()
  ipcMain.handle(ELECTRON_IPC.cancelImageRecognition, (event, id: unknown) => {
    trusted(event)
    if (typeof id === "string") jobs.get(event.sender)?.get(id)?.abort()
  })
  ipcMain.handle(ELECTRON_IPC.recognizeImage, async (event, bytes: Uint8Array, id: unknown) => {
    trusted(event)
    if (!(bytes instanceof Uint8Array) || !bytes.byteLength || bytes.byteLength > MAX_BYTES || typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new Error("Invalid image request")
    const owner = jobs.get(event.sender) ?? new Map<string, AbortController>()
    jobs.set(event.sender, owner)
    if (owner.has(id) || owner.size >= 4) throw new Error("Too many recognition requests")
    const controller = new AbortController()
    owner.set(id, controller)
    const cancel = () => controller.abort()
    const navigating = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => { if (event.isMainFrame && !event.isSameDocument) cancel() }
    event.sender.once("destroyed", cancel)
    event.sender.on("did-start-navigation", navigating)
    try {
      const result = await recognize(Buffer.from(bytes), controller.signal)
      return { lines: result.textLines, lineBounds: result.lineBounds }
    } finally {
      owner.delete(id)
      event.sender.removeListener("destroyed", cancel)
      event.sender.removeListener("did-start-navigation", navigating)
    }
  })
}
