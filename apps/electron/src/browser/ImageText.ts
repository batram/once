import { type ContextMenuParams, type WebContents } from "electron"
import { randomUUID } from "node:crypto"
import type { ImageTextResult } from "@once/ui-web/imageText/imageTextTypes"
import { ImageTextOverlay } from "./ImageTextOverlay"
import type { ImageTextPicture } from "./ImageTextPicture"
import { nativeTextRecognitionAvailable, recognize } from "./NativeTextRecognition"

const MAX_BYTES = 32 * 1024 * 1024
const active = new WeakMap<WebContents, AbortController>()

/** User-initiated, on-device recognition; no bridge is exposed to remote pages. */
export async function selectImageText(contents: WebContents, params: ContextMenuParams): Promise<void> {
  const frame = params.frame
  if (!nativeTextRecognitionAvailable || !frame || !params.hasImageContents) return
  active.get(contents)?.abort()
  const controller = new AbortController()
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
  active.set(contents, controller)
  const token = randomUUID()
  const cancel = () => controller.abort()
  const navigating = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (!event.isSameDocument && (event.isMainFrame || event.frame === frame)) cancel()
  }
  contents.once("destroyed", cancel)
  contents.on("did-start-navigation", navigating)
  let overlay: ImageTextOverlay | null = null
  try {
    overlay = await ImageTextOverlay.open(contents, frame, params.srcURL, params.x, params.y, token, signal)
    if (!overlay) return
    if (signal.aborted) { overlay.close(); return }
    overlay.onClose(cancel)
    controller.signal.addEventListener("abort", overlay.close, { once: true })
    // The image as the tab already has it, never fetched again (see the host's `picture`).
    const picture: ImageTextPicture | null = params.srcURL.startsWith("data:")
      ? { bytes: decodeImageData(params.srcURL) }
      : await overlay.picture(signal)
    signal.throwIfAborted()
    if (!picture?.bytes.length) throw new Error("The tab holds no copy of the image")
    if (picture.bytes.length > MAX_BYTES) throw new Error("Image too large")
    overlay.setImage(picture.bytes)
    const result = await recognize(picture.bytes, signal)
    if (!signal.aborted) overlay.finish(picture.part ? inPicture(result, picture.part) : result)
  } catch (error) {
    if (!controller.signal.aborted) {
      console.warn("Image text recognition failed", error instanceof Error ? error.message : String(error))
      overlay?.finish(null, signal.aborted ? "Image recognition timed out. Try again." : "Couldn’t recognize this image. Try another image.")
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

/** Words read from part of the picture, placed as fractions of the whole of it. */
function inPicture(result: ImageTextResult, part: NonNullable<ImageTextPicture["part"]>): ImageTextResult {
  const at = (point: { x: number; y: number }) => ({ x: part.left + point.x * part.width, y: part.top + point.y * part.height })
  return { ...result, lines: result.lines.map((line) => line.map((word) =>
    ({ ...word, topLeft: at(word.topLeft), topRight: at(word.topRight), bottomLeft: at(word.bottomLeft) }))) }
}
