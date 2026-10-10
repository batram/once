import { app, type ContextMenuParams, type WebContents } from "electron"
import { spawn } from "node:child_process"
import { readFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import path from "node:path"
import type { ImageTextResult } from "./imageTextTypes"

const MAX_BYTES = 32 * 1024 * 1024
const active = new WeakMap<WebContents, AbortController>()
let injection: string | undefined

/** User-initiated, on-device recognition; no bridge is exposed to remote pages. */
export async function selectImageText(contents: WebContents, params: ContextMenuParams): Promise<void> {
  const frame = params.frame
  if (process.platform !== "darwin" || !frame || !params.hasImageContents) return
  active.get(contents)?.abort()
  const controller = new AbortController()
  active.set(contents, controller)
  const token = randomUUID()
  const url = frame.url
  const cancel = () => controller.abort()
  const navigating = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (!event.isSameDocument && (event.isMainFrame || event.frame === frame)) cancel()
  }
  contents.once("destroyed", cancel)
  contents.on("did-start-navigation", navigating)
  const finish = async (result: ImageTextResult | null, message?: string) => {
    if (contents.isDestroyed() || frame.detached || controller.signal.aborted) return
    await frame.executeJavaScript(`if(window.__onceImageText?.token === ${JSON.stringify(token)}) {
      window.__onceImageText.finish(${JSON.stringify(result)}, ${JSON.stringify(message ?? "")})
    }`)
  }
  try {
    injection ??= readFileSync(path.join(__dirname, "image-text-injection.js"), "utf8")
    await frame.executeJavaScript(injection)
    const started = await frame.executeJavaScript(`window.__onceStartImageText(${JSON.stringify(params.srcURL)},
      ${Number(params.x)}, ${Number(params.y)}, ${JSON.stringify(token)})`, true)
    if (!started) return
    const scheme = new URL(params.srcURL).protocol
    if (!["http:", "https:", "data:"].includes(scheme)) throw new Error("Unsupported image URL")
    const bytes = scheme === "data:"
      ? decodeImageData(params.srcURL)
      : await fetchImage(contents, params.srcURL, url, controller.signal)
    await finish(await recognize(bytes, controller.signal))
  } catch (error) {
    if (!controller.signal.aborted) {
      console.warn("Image text recognition failed", error instanceof Error ? error.message : String(error))
      await finish(null, "Couldn’t recognize this image. Try another image.").catch(() => undefined)
    }
  } finally {
    contents.removeListener("destroyed", cancel)
    contents.removeListener("did-start-navigation", navigating)
    if (active.get(contents) === controller) active.delete(contents)
  }
}

function decodeImageData(url: string): Buffer {
  if (url.length > MAX_BYTES * 1.4) throw new Error("Image too large")
  const comma = url.indexOf(",")
  if (comma < 0 || !url.slice(0, comma).startsWith("data:image/")) throw new Error("Invalid image")
  const bytes = url.slice(0, comma).endsWith(";base64")
    ? Buffer.from(url.slice(comma + 1), "base64")
    : Buffer.from(decodeURIComponent(url.slice(comma + 1)))
  if (bytes.length > MAX_BYTES) throw new Error("Image too large")
  return bytes
}

async function fetchImage(contents: WebContents, src: string, referrer: string, signal: AbortSignal): Promise<Buffer> {
  const response = await contents.session.fetch(src, {
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]), headers: { Referer: referrer }
  })
  if (!response.ok || !response.body) throw new Error("Image unavailable")
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > MAX_BYTES) throw new Error("Image too large")
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  return Buffer.concat(chunks)
}

function recognize(bytes: Buffer, signal: AbortSignal): Promise<ImageTextResult> {
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
