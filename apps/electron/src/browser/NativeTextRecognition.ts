import { ELECTRON_IPC } from "@once/platform-electron/bridge"
import { app, ipcMain, type IpcMainInvokeEvent } from "electron"
import { spawn } from "node:child_process"
import path from "node:path"
import type { ImageTextResult } from "./imageTextTypes"

const MAX_BYTES = 32 * 1024 * 1024

/** Shared Apple Vision backend for image selection and document retrieval. */
export function recognize(bytes: Buffer, signal: AbortSignal): Promise<ImageTextResult> {
  if (process.platform !== "darwin") return Promise.reject(new Error("Image text recognition is not available on this platform yet"))
  if (!bytes.length || bytes.length > MAX_BYTES) return Promise.reject(new Error("Invalid image size"))
  const executable = app.isPackaged
    ? path.join(process.resourcesPath, "once-image-text")
    : path.resolve(__dirname, "../../../.native/once-image-text")
  return new Promise((resolve, reject) => {
    const child = spawn(executable, [], { stdio: ["pipe", "pipe", "pipe"], signal })
    const timer = setTimeout(() => { child.kill(); reject(new Error("Recognition timed out")) }, 20_000)
    let output = ""
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
      output += chunk
      if (output.length > 4 * 1024 * 1024) child.kill()
    })
    child.stderr.resume()
    child.stdin.on("error", () => undefined)
    child.on("error", reject)
    child.on("close", (code) => {
      clearTimeout(timer)
      if (code !== 0) { reject(new Error("Native recognition failed")); return }
      try { resolve(JSON.parse(output) as ImageTextResult) } catch (error) { reject(error) }
    })
    child.stdin.end(bytes)
  })
}

export function registerTextRecognition(trusted: (event: IpcMainInvokeEvent) => void): void {
  ipcMain.handle(ELECTRON_IPC.recognizeImage, async (event, bytes: Uint8Array) => {
    trusted(event)
    if (!(bytes instanceof Uint8Array) || bytes.byteLength > MAX_BYTES) throw new Error("Invalid image")
    const result = await recognize(Buffer.from(bytes), AbortSignal.timeout(20_000))
    return { lines: result.textLines, lineBounds: result.lineBounds }
  })
}
