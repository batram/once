import type { WebContents } from "electron"

/** Tall pages are cut to this shape, top first, as other browsers do. */
const MAX_ASPECT = 10 / 16

/**
 * A JPEG of a tab's top, `width` pixels wide at most. stayHidden keeps a
 * background tab hidden to its page (no visibilitychange) while Chromium
 * still paints it for the capture. Null for an empty or failed capture.
 */
export async function captureTab(
  contents: WebContents,
  width: number,
  quality: number
): Promise<{ jpeg: string; width: number; height: number } | null> {
  try {
    const image = await contents.capturePage(undefined, { stayHidden: true })
    if (image.isEmpty()) return null
    const size = image.getSize()
    const height = Math.min(size.height, Math.round(size.width * MAX_ASPECT))
    const scaled = image.crop({ x: 0, y: 0, width: size.width, height })
      .resize({ width: Math.min(width, size.width), quality: "good" })
    const scaledSize = scaled.getSize()
    return { jpeg: scaled.toJPEG(quality).toString("base64"), width: scaledSize.width, height: scaledSize.height }
  } catch {
    return null
  }
}
