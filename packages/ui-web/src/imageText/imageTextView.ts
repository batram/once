import type { ImageTextFit, ImageTextViewBridge, ImageTextViewLayout } from "./imageTextTypes"
import { ImageTextBlocks } from "./imageTextBlocks"
import { ImageTextHighlights, selectionRange } from "./imageTextHighlights"
import { ImageTextLayer } from "./imageTextLayer"
import { OVERLAY_CSS, renderWords } from "./imageTextOverlay"
import { ImageTextPointer } from "./imageTextPointer"
import { playRecognitionScan } from "./imageTextScan"

/**
 * The image text overlay's words in a document of their own, so page styles
 * and scripts never reach them: Electron's cross-origin frame anchored to the
 * page's image (see imageTextAnchor.ts), Android's system WebView over it.
 * The view is the image's content box and holds the selectable words.
 */

// The view is the overlay's whole viewport: the clip fills it.
const VIEW_CSS = `
  .clip { left: 0; top: 0; width: 100%; height: 100%; }
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
  // The picture itself, as recognition read it: only the reading flourish
  // looks at it (for its brightness); the page shows the image.
  const image = new Image()
  const highlights = new ImageTextHighlights(shadow, words)
  const blocks = new ImageTextBlocks(words, () => selectionRange(shadow))
  let layout: ImageTextViewLayout | null = null
  // A sweep near the page's edge scrolls the page, which the host does for us.
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
      image.src = message.url
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
      // The host keeps the bar off the words, wherever the picture moves.
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
