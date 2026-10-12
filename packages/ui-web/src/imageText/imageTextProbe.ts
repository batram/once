import { uncoveredBox } from "./imageTextCover"
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
  const visibleBox = fit.visible ? uncoveredBox(element, fit.visibleBox) : fit.visibleBox
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
