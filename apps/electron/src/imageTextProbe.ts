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
  const fit = imageFit(image)
  const visibleBox = fit.visible ? uncovered(image, fit.visibleBox) : fit.visibleBox
  return { ...fit, visibleBox, visible: visibleBox.bottom > visibleBox.top && visibleBox.right > visibleBox.left,
    naturalWidth: image.naturalWidth, naturalHeight: image.naturalHeight, viewportWidth: view.width, viewportHeight: view.height }
}

type Box = ImageTextFit["visibleBox"]

/** Whether the image is what shows at a viewport point, rather than something the page draws over it. */
function showsImage(image: HTMLImageElement, x: number, y: number): boolean {
  const top = document.elementFromPoint(x, y)
  // An ancestor answers for an image with pointer-events: none.
  return Boolean(top && (top === image || top.contains(image)))
}

/**
 * The visible box less the bands the page covers at its edges: fixed
 * headers, banners and dialogs over the image. The app's views stack above
 * the whole page, so without this the selection would show through them.
 * Each edge moves in only as far as every sampled line agrees it is covered,
 * so a small badge in one corner keeps the box whole; when no sample shows
 * the image at all, something transparent covers it and the box stays.
 */
function uncovered(image: HTMLImageElement, box: Box): Box {
  const result = { ...box }
  const lines = (from: number, to: number) => [0.2, 0.5, 0.8].map((at) => from + (to - from) * at)
  // The first point from `start` towards `end` where the image shows, or null.
  const firstShown = (start: number, end: number, at: (position: number) => boolean): number | null => {
    const direction = Math.sign(end - start), step = Math.max(4, Math.abs(end - start) / 48)
    let miss = start
    for (let position = start; direction * (end - position) >= 0; position += direction * step) {
      if (at(position)) {
        // Refine between the last covered sample and this one.
        let shown = position
        while (Math.abs(shown - miss) > 1) {
          const middle = (shown + miss) / 2
          if (at(middle)) shown = middle
          else miss = middle
        }
        return shown
      }
      miss = position
    }
    return null
  }
  const edge = (hits: (number | null)[], pick: (values: number[]) => number) => {
    const found = hits.filter((hit): hit is number => hit !== null)
    return found.length ? pick(found) : null
  }
  const inset = 0.5
  const columns = lines(box.left + inset, box.right - inset)
  const top = edge(columns.map((x) => firstShown(box.top + inset, box.bottom - inset, (y) => showsImage(image, x, y))), (v) => Math.min(...v))
  if (top === null) return result
  const bottom = edge(columns.map((x) => firstShown(box.bottom - inset, box.top + inset, (y) => showsImage(image, x, y))), (v) => Math.max(...v))
  result.top = Math.max(box.top, Math.floor(top))
  result.bottom = Math.min(box.bottom, Math.ceil((bottom ?? box.bottom) + inset))
  const rows = lines(result.top + inset, result.bottom - inset)
  const left = edge(rows.map((y) => firstShown(box.left + inset, box.right - inset, (x) => showsImage(image, x, y))), (v) => Math.min(...v))
  const right = edge(rows.map((y) => firstShown(box.right - inset, box.left + inset, (x) => showsImage(image, x, y))), (v) => Math.max(...v))
  if (left !== null) result.left = Math.max(box.left, Math.floor(left))
  if (right !== null) result.right = Math.min(box.right, Math.ceil(right + inset))
  return result
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
