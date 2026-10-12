import { IMAGE_TEXT_MENU_ITEM, IMAGE_TEXT_OVERLAY_MENU_ITEM, type InAppBrowserSurface } from "@once/platform-mobile"
import type { ImageTextResult } from "@once/ui-web/imageText/imageTextTypes"

/**
 * "Select text in image" from a page's native long-press menu (Android, which
 * has no Live Text): the shared overlay is injected into the long-pressed tab,
 * the native side fetches the image through the browser engine and recognizes
 * it on device, and the words are handed to the overlay for selection.
 */
export function installMobileImageText(surface: InAppBrowserSurface): Promise<() => void> {
  return surface.addListener("contextMenuAction", (event) => {
    if ((event.id !== IMAGE_TEXT_MENU_ITEM && event.id !== IMAGE_TEXT_OVERLAY_MENU_ITEM) || !event.image) return
    const page = event.tabId && event.generation && surface.forTab
      ? surface.forTab({ tabId: event.tabId, generation: event.generation })
      : surface
    if (event.id === IMAGE_TEXT_OVERLAY_MENU_ITEM) void selectImageTextOutOfPage(page, event.image, event.referrer)
    else void selectImageText(page, event.image, event.referrer)
  })
}

async function selectImageText(page: InAppBrowserSurface, image: string, referrer?: string): Promise<void> {
  if (!page.recognizeImageUrl) return
  const token = crypto.randomUUID()
  const finish = (result: ImageTextResult | null, message = "") => page.evaluateJavaScript(
    `window.__onceImageText?.token === ${JSON.stringify(token)} && ` +
    `window.__onceImageText.finish(${JSON.stringify(result)}, ${JSON.stringify(message)})`)
  try {
    await page.evaluateJavaScript(await loadBundle("image-text-injection.js"))
    // A touch menu reports no point: the overlay takes the matching image in view.
    const started = await page.evaluateJavaScript(
      `window.__onceStartImageText(${JSON.stringify(image)}, NaN, NaN, ${JSON.stringify(token)})`)
    // Not in the page's own document (such as in a frame), or no longer there: say so.
    if (started !== "true") { await page.imageTextOverlay?.({ action: "missing", token }).catch(() => undefined); return }
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

/**
 * The prototype beside it: the app lays its own view over the image instead
 * of injecting the overlay. A read-only probe, evaluated in the page's bridge
 * content script, reports where the image is: once here, then each change
 * straight to the native overlay through the script's port.
 */
async function selectImageTextOutOfPage(page: InAppBrowserSurface, image: string, referrer?: string): Promise<void> {
  if (!page.recognizeImageUrl || !page.imageTextOverlay) return
  const token = crypto.randomUUID()
  try {
    await page.evaluateJavaScript(await loadBundle("image-text-probe.js"))
    // A touch menu reports no point: the probe takes the matching image in view.
    const fit = await page.evaluateJavaScript(
      `window.__onceImageTextProbe.start(${JSON.stringify(image)}, NaN, NaN, ${JSON.stringify(token)})`)
    if (!fit || fit === "null") return
    await page.imageTextOverlay({ action: "open", token, fit: JSON.parse(fit) as unknown })
  } catch {
    return
  }
  try {
    const recognized = await page.recognizeImageUrl(image, referrer)
    await page.imageTextOverlay({ action: "result", token,
      result: { lines: recognized.words, textLines: recognized.lines, lineBounds: recognized.lineBounds } })
  } catch {
    await page.imageTextOverlay({ action: "result", token, result: null,
      message: "Couldn’t recognize this image. Try another image." }).catch(() => undefined)
  }
}

function loadBundle(name: string): Promise<string> {
  return fetch(new URL(name, document.baseURI)).then((response) => {
    if (!response.ok) throw new Error(`The ${name} bundle could not be loaded`)
    return response.text()
  })
}
