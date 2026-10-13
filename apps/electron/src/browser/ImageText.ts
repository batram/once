import { type ContextMenuParams, ipcMain, type WebContents } from "electron"
import { randomUUID } from "node:crypto"
import type { ImageTextResult } from "@once/ui-web/imageText/imageTextTypes"
import { IMAGE_TEXT_IPC } from "./imageTextIpc"
import { ImageTextOverlay } from "./ImageTextOverlay"
import type { ImageTextPicture } from "./ImageTextPicture"
import { nativeTextRecognitionAvailable, recognize } from "./NativeTextRecognition"

const MAX_BYTES = 32 * 1024 * 1024
const active = new WeakMap<WebContents, AbortController>()

type ImageTextTarget = Pick<ContextMenuParams, "frame" | "srcURL" | "x" | "y" | "hasImageContents">

/**
 * Double-clicking an image selects its text, as the menu item does. The frame
 * preload reports the image from its isolated world, for trusted double clicks
 * only, so the page's own scripts can neither start nor see it; a page that
 * handles the clicks itself (or a link that navigates) simply wins. Only tabs
 * load that preload; their session may be an extension profile's, not the
 * browsing partition's.
 */
export function selectImageTextOnDoubleClick(): void {
  ipcMain.on(IMAGE_TEXT_IPC.request, (event, request: { src?: unknown; x?: unknown; y?: unknown }) => {
    const { src, x, y } = request ?? {}
    if (!event.senderFrame) return
    if (typeof src !== "string" || src.length > MAX_BYTES * 1.4 || !Number.isFinite(x) || !Number.isFinite(y)) return
    void selectImageText(event.sender, { frame: event.senderFrame, srcURL: src, x: x as number, y: y as number, hasImageContents: true })
  })
}

/** User-initiated, on-device recognition; no bridge is exposed to remote pages. */
export async function selectImageText(contents: WebContents, params: ImageTextTarget): Promise<void> {
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
    // An SVG is captured as shown (see openImageTextHost): the native helper cannot decode one.
    const picture: ImageTextPicture | null = params.srcURL.startsWith("data:") && !params.srcURL.startsWith("data:image/svg+xml")
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
