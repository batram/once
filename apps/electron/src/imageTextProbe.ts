import { findImage, imageFit, viewport } from "@once/ui-web/imageText/imageTextOverlay"
import type { ImageTextFit } from "@once/ui-web/imageText/imageTextTypes"

// Run by the main process in an isolated world of the tab's main frame (see
// browser/ImageTextOverlay.ts): it only reads where the chosen image is drawn.
// It adds nothing to the page, and the page's own scripts cannot see or patch
// what it uses. The overlay itself lives in app-owned views over the tab.

export interface ImageTextProbeFit extends ImageTextFit {
  naturalWidth: number
  naturalHeight: number
  /** The page's viewport without scrollbars, in CSS pixels. */
  viewportWidth: number
  viewportHeight: number
}

declare global {
  interface Window {
    __onceImageTextProbe?: {
      start(src: string, x: number, y: number, token: string): ImageTextProbeFit | null
      measure(token: string): ImageTextProbeFit | null
      stop(token: string): void
    }
  }
}

let current: { token: string; image: HTMLImageElement; source: string } | null = null

function measure(token: string): ImageTextProbeFit | null {
  if (current?.token !== token) return null
  const { image, source } = current
  if (!image.isConnected || (image.currentSrc || image.src) !== source || !image.naturalWidth) return null
  const view = viewport()
  return { ...imageFit(image), naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight,
    viewportWidth: view.width, viewportHeight: view.height }
}

window.__onceImageTextProbe ??= {
  start(src, x, y, token) {
    const image = findImage(src, x, y)
    current = image ? { token, image, source: image.currentSrc || image.src } : null
    return measure(token)
  },
  measure,
  stop(token) { if (current?.token === token) current = null }
}
