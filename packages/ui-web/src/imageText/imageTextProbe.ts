import { findImage, imageFit, viewport } from "./imageTextOverlay"
import type { ImageTextFit } from "./imageTextTypes"

// The app runs this where page scripts cannot see it: an isolated world on
// Electron (see its browser/ImageTextProbes.ts), the bridge extension's
// content script on Android. It only reads where the chosen image is drawn,
// or, in each frame above the image's, where the iframe holding it is, and
// adds nothing to the page. The overlay itself lives in app-owned views.

export interface ImageTextProbeFit extends ImageTextFit {
  /** The image's natural size; an iframe's content size. */
  naturalWidth: number
  naturalHeight: number
  /** This frame's viewport without scrollbars, and its layout width, in its CSS pixels. */
  viewportWidth: number
  viewportHeight: number
  innerWidth: number
  /**
   * The visual viewport (a pinch-zoomed part of the layout viewport) and the
   * device pixels per CSS pixel, which place the fit on screen: a point is at
   * (x - visualLeft) * visualScale * pixelRatio device pixels.
   */
  visualLeft: number
  visualTop: number
  visualScale: number
  pixelRatio: number
}

/** What a probe pushes through the app's binding: its element's fit, or null once that is gone. */
export interface ImageTextProbeReport { token: string; fit: ImageTextProbeFit | null }

declare global {
  interface Window {
    __onceImageTextProbe?: {
      start(src: string, x: number, y: number, token: string): ImageTextProbeFit | null
      frame(owner: HTMLIFrameElement, token: string): ImageTextProbeFit | null
      measure(token: string): ImageTextProbeFit | null
      stop(token: string): void
    }
    /**
     * Installed in this world only by the app, when it listens for changes: a
     * DevTools protocol binding (Electron) or the content script's port (Android).
     */
    __onceImageTextPush?: (payload: string) => void
  }
}

/** Where the push lives: Firefox content scripts keep their own globals off the (Xray) window. */
function pusher(): ((payload: string) => void) | undefined {
  return (globalThis as { __onceImageTextPush?: (payload: string) => void }).__onceImageTextPush ?? window.__onceImageTextPush
}

interface Tracked { token: string; element: HTMLImageElement | HTMLIFrameElement; source: string }

let current: Tracked | null = null
let frame = 0
let last = ""

function measure(token: string): ImageTextProbeFit | null {
  if (current?.token !== token) return null
  const { element, source } = current
  if (!element.isConnected) return null
  const image = element instanceof HTMLImageElement ? element : null
  if (image && ((image.currentSrc || image.src) !== source || !image.naturalWidth)) return null
  const view = viewport()
  const fit = imageFit(element)
  const visibleBox = fit.visible ? uncovered(element, fit.visibleBox) : fit.visibleBox
  return { ...fit, visibleBox, visible: visibleBox.bottom > visibleBox.top && visibleBox.right > visibleBox.left,
    naturalWidth: image?.naturalWidth ?? fit.width, naturalHeight: image?.naturalHeight ?? fit.height,
    viewportWidth: view.width, viewportHeight: view.height, innerWidth,
    visualLeft: visualViewport?.offsetLeft ?? 0, visualTop: visualViewport?.offsetTop ?? 0,
    visualScale: visualViewport?.scale ?? 1, pixelRatio: devicePixelRatio || 1 }
}

/** With the app listening, reports each animation frame in which the element moved, changed or went away. */
function track(next: Tracked | null): ImageTextProbeFit | null {
  cancelAnimationFrame(frame)
  current = next
  last = ""
  if (!next) return null
  const push = pusher()
  const report = () => {
    const fit = measure(next.token)
    const payload = JSON.stringify({ token: next.token, fit } satisfies ImageTextProbeReport)
    if (payload !== last) {
      last = payload
      push?.(payload)
    }
    if (fit && current === next) frame = requestAnimationFrame(report)
  }
  if (push) frame = requestAnimationFrame(report)
  return measure(next.token)
}

export function installImageTextProbe(): void {
  window.__onceImageTextProbe ??= {
    start(src, x, y, token) {
      const image = findImage(src, x, y)
      return track(image ? { token, element: image, source: image.currentSrc || image.src } : null)
    },
    frame(owner, token) {
      return track(owner instanceof HTMLIFrameElement ? { token, element: owner, source: "" } : null)
    },
    measure,
    stop(token) { if (current?.token === token) track(null) }
  }
}

type Box = ImageTextFit["visibleBox"]

/** Whether the element is what shows at a viewport point, rather than something the page draws over it. */
function showsImage(image: Element, x: number, y: number): boolean {
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
function uncovered(image: Element, box: Box): Box {
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
