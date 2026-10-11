import { IMAGE_TEXT_MENU_ITEM, type InAppBrowserSurface } from "@once/platform-mobile"
import type { ImageTextResult } from "@once/ui-web/imageText/imageTextTypes"

/**
 * "Select text in image" from a page's native long-press menu (Android, which
 * has no Live Text): the shared overlay is injected into the long-pressed tab,
 * the native side fetches the image through the browser engine and recognizes
 * it on device, and the words are handed to the overlay for selection.
 */
export function installMobileImageText(surface: InAppBrowserSurface): Promise<() => void> {
  return surface.addListener("contextMenuAction", (event) => {
    if (event.id !== IMAGE_TEXT_MENU_ITEM || !event.image) return
    const page = event.tabId && event.generation && surface.forTab
      ? surface.forTab({ tabId: event.tabId, generation: event.generation })
      : surface
    void selectImageText(page, event.image, event.referrer)
  })
}

async function selectImageText(page: InAppBrowserSurface, image: string, referrer?: string): Promise<void> {
  if (!page.recognizeImageUrl) return
  const token = crypto.randomUUID()
  const finish = (result: ImageTextResult | null, message = "") => page.evaluateJavaScript(
    `window.__onceImageText?.token === ${JSON.stringify(token)} && ` +
    `window.__onceImageText.finish(${JSON.stringify(result)}, ${JSON.stringify(message)})`)
  try {
    await page.evaluateJavaScript(await loadImageTextInjection())
    // A touch menu reports no point: the overlay takes the matching image in view.
    const started = await page.evaluateJavaScript(
      `window.__onceStartImageText(${JSON.stringify(image)}, NaN, NaN, ${JSON.stringify(token)})`)
    if (started !== "true") return
  } catch {
    return
  }
  try {
    const recognized = await page.recognizeImageUrl(image, referrer)
    await finish({ lines: recognized.words, textLines: recognized.lines, lineBounds: recognized.lineBounds })
  } catch {
    await finish(null, "Couldn’t recognize this image. Try another image.").catch(() => undefined)
  }
}

function loadImageTextInjection(): Promise<string> {
  return fetch(new URL("image-text-injection.js", document.baseURI)).then((response) => {
    if (!response.ok) throw new Error("The image text bundle could not be loaded")
    return response.text()
  })
}
