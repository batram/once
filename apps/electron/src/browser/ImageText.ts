import { type ContextMenuParams, type WebContents } from "electron"
import { randomUUID } from "node:crypto"
import { ImageTextOverlay } from "./ImageTextOverlay"
import { nativeTextRecognitionAvailable, recognize } from "./NativeTextRecognition"

const MAX_BYTES = 32 * 1024 * 1024
const active = new WeakMap<WebContents, AbortController>()

/** User-initiated, on-device recognition; no bridge is exposed to remote pages. */
export async function selectImageText(contents: WebContents, params: ContextMenuParams): Promise<void> {
  const frame = params.frame
  if (!nativeTextRecognitionAvailable || !frame || !params.hasImageContents) return
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
  let overlay: ImageTextOverlay | null = null
  try {
    // The selection hangs on the image from an isolated world, its words in a
    // cross-origin frame of the app's own. A subframe cannot safely fall back
    // to executeJavaScript when another DevTools client owns the debugger:
    // that would put the recognized text in the remote page's script world.
    overlay = await ImageTextOverlay.open(contents, frame, params.srcURL, params.x, params.y, token)
    if (!overlay) return
    overlay.onClose(cancel)
    controller.signal.addEventListener("abort", overlay.close)
    const scheme = new URL(params.srcURL).protocol
    if (!["http:", "https:", "data:"].includes(scheme)) throw new Error("Unsupported image URL")
    const bytes = scheme === "data:"
      ? decodeImageData(params.srcURL)
      : await fetchImage(contents, params.srcURL, url, controller.signal)
    overlay.setImage(bytes)
    const result = await recognize(bytes, controller.signal)
    if (!controller.signal.aborted) overlay.finish(result)
  } catch (error) {
    if (!controller.signal.aborted) {
      console.warn("Image text recognition failed", error instanceof Error ? error.message : String(error))
      overlay?.finish(null, "Couldn’t recognize this image. Try another image.")
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
