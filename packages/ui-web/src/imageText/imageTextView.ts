import type { ImageTextFit, ImageTextViewBridge, ImageTextViewLayout } from "./imageTextTypes"
import { ImageTextBlocks } from "./imageTextBlocks"
import { ImageTextHighlights, selectionRange } from "./imageTextHighlights"
import { ImageTextLayer } from "./imageTextLayer"
import { OVERLAY_CSS, renderWords } from "./imageTextOverlay"
import { ImageTextPointer } from "./imageTextPointer"
import { playRecognitionScan } from "./imageTextScan"

/**
 * The image text overlay in a document of its own: the app lays a transparent
 * view over the page's image (see Electron's ImageTextOverlay.ts) instead of
 * injecting UI into the page, so page styles, scripts and stacking never reach
 * it. The words view covers the image's visible part and holds the selectable
 * words; the bar view, beside it, holds the status and Done.
 */

// Each view is the overlay's whole viewport: the clip fills it and the bar
// sits in its own view, inset so its shadow is not cut off. That view is sized
// from the bar, so the bar must not size itself from the view.
const VIEW_CSS = `
  .clip { left: 0; top: 0; width: 100%; height: 100%; }
  .bar { position: relative; margin: 6px; max-width: 640px; }
`

function shadowHost(): ShadowRoot {
  const host = document.createElement("div")
  host.dataset.onceImageText = ""
  const shadow = host.attachShadow({ mode: "open" })
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(OVERLAY_CSS + VIEW_CSS)
  shadow.adoptedStyleSheets = [sheet]
  document.body.append(host)
  return shadow
}

export function startImageTextWordsView(bridge: ImageTextViewBridge): void {
  const shadow = shadowHost()
  const clip = document.createElement("div")
  clip.className = "clip"
  const words = document.createElement("div")
  words.className = "words"
  clip.append(words)
  shadow.append(clip)
  // The picture itself, from the bytes recognition read: only the reading
  // flourish looks at it (for its brightness); the page shows the image.
  const image = new Image()
  const highlights = new ImageTextHighlights(shadow, words)
  const blocks = new ImageTextBlocks(words, () => selectionRange(shadow))
  let layout: ImageTextViewLayout | null = null
  // A sweep near the page's edge scrolls the page, which the app does for us.
  const pointer = new ImageTextPointer(shadow, clip, words, image,
    (sweeping) => bridge.send({ type: "sweeping", sweeping }), {
      edges: () => ({ top: layout?.pageTop ?? 0, bottom: layout?.pageBottom ?? innerHeight }),
      scrollBy: (deltaY) => bridge.send({ type: "scroll", deltaY }),
      origin: () => ({ x: layout?.viewLeft ?? 0, y: layout?.viewTop ?? 0 })
    })
  const wordRects = () => [...words.querySelectorAll(".word")].map((word) => word.getBoundingClientRect())
  let stopScan: () => void = () => undefined

  const place = () => {
    if (!layout) return
    Object.assign(words.style, { left: `${layout.left}px`, top: `${layout.top}px`,
      transform: `scale(${layout.width / layout.naturalWidth}, ${layout.height / layout.naturalHeight})` })
  }
  bridge.onMessage((message) => {
    if (message.type === "layout") {
      layout = message.layout
      place()
    } else if (message.type === "image") {
      image.src = URL.createObjectURL(new Blob([message.bytes as Uint8Array<ArrayBuffer>]))
    } else if (message.type === "result") {
      const result = message.result
      if (!layout || !result?.lines.some((line) => line.length)) {
        bridge.send({ type: "status", text: message.message || "No text found in this image" })
        return
      }
      renderWords(words, result, layout.naturalWidth, layout.naturalHeight)
      highlights.attach(layout.naturalWidth, layout.naturalHeight)
      blocks.attach(result)
      place()
      // The app keeps the bar off the words, wherever the picture moves.
      const picture = words.getBoundingClientRect()
      bridge.send({ type: "words", boxes: wordRects().map((rect) => ({
        left: (rect.left - picture.left) / picture.width, top: (rect.top - picture.top) / picture.height,
        right: (rect.right - picture.left) / picture.width, bottom: (rect.bottom - picture.top) / picture.height
      })) })
      stopScan()
      stopScan = playRecognitionScan(image, clip, wordRects)
      bridge.send({ type: "status", text: `Drag to select text · ${/^Mac/.test(navigator.platform) ? "⌘C" : "Ctrl+C"} to copy` })
    }
  })
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); bridge.send({ type: "close" }) }
  })
  // The view covers the image, so the page's scrolling is handed back to it.
  addEventListener("wheel", (event) => {
    if (event.ctrlKey) return
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? innerHeight : 1
    bridge.send({ type: "wheel", x: event.clientX, y: event.clientY, deltaX: event.deltaX * unit, deltaY: event.deltaY * unit })
  }, { passive: true })
  const frame = () => {
    highlights.update()
    pointer.update()
    requestAnimationFrame(frame)
  }
  requestAnimationFrame(frame)
}

/**
 * The words view for screens that select with the platform's own touch
 * carets (Android's system WebView, over GeckoView): the gapless text layer
 * of imageTextLayer.ts over the picture. The bar is the app's own native
 * view, which asks this view for the text to copy.
 */
export function startImageTextLayerView(bridge: ImageTextViewBridge): { copyText(): string } {
  const shadow = shadowHost()
  // Carries only the reading flourish; the layer below takes the touches.
  const clip = document.createElement("div")
  clip.className = "clip passive"
  shadow.append(clip)
  const layer = new ImageTextLayer("", { inline: true })
  const blocks = new ImageTextBlocks(layer.words, () => layer.range())
  let layout: ImageTextViewLayout | null = null
  let stopScan: () => void = () => undefined
  // The view is the picture's visible part, so the layer's fit needs no clip.
  const fit = (): ImageTextFit | null => layout && {
    left: layout.left, top: layout.top, width: layout.width, height: layout.height, clipPath: "none",
    visibleBox: { left: 0, top: 0, right: innerWidth, bottom: innerHeight }, visible: true,
    imageLeft: 0, imageTop: 0, imageWidth: layout.width, imageHeight: layout.height
  }
  bridge.onMessage((message) => {
    if (message.type === "layout") {
      layout = message.layout
      const current = fit()
      if (current) layer.update(current)
    } else if (message.type === "result") {
      const result = message.result
      const current = fit()
      if (!current || !result?.lines.some((line) => line.length)) {
        bridge.send({ type: "status", text: message.message || "No text found in this image" })
        return
      }
      layer.show(result)
      layer.update(current)
      blocks.attach(result)
      stopScan()
      // No picture here to judge its brightness by: the flourish treats it as paper.
      stopScan = playRecognitionScan(new Image(), clip, () => layer.wordRects())
      bridge.send({ type: "status", text: "Long-press text to select" })
    }
  })
  return { copyText: () => blocks.copyText() }
}

export function startImageTextBarView(bridge: ImageTextViewBridge): void {
  const shadow = shadowHost()
  const bar = document.createElement("div")
  bar.className = "bar"
  bar.setAttribute("role", "region")
  bar.setAttribute("aria-label", "Image text selection")
  const status = document.createElement("span")
  status.setAttribute("role", "status")
  status.textContent = "Recognizing text…"
  const done = document.createElement("button")
  done.type = "button"
  done.textContent = "Done"
  done.onclick = () => bridge.send({ type: "close" })
  bar.append(status, done)
  shadow.append(bar)
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") { event.preventDefault(); bridge.send({ type: "close" }) }
  })
  // Measured on the spot, not by a ResizeObserver: the view starts empty and
  // off the window, where no frames are rendered and observers never report.
  let size = ""
  const measure = () => {
    const rect = bar.getBoundingClientRect()
    const next = { width: Math.ceil(rect.width + 12), height: Math.ceil(rect.height + 12) }
    if (JSON.stringify(next) === size) return
    size = JSON.stringify(next)
    bridge.send({ type: "size", ...next })
  }
  measure()
  void document.fonts.ready.then(measure)
  bridge.onMessage((message) => {
    if (message.type === "status") { status.textContent = message.text; measure() }
    else if (message.type === "sweeping") bar.classList.toggle("sweeping", message.sweeping)
  })
}
