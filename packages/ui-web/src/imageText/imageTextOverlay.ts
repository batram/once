import type { ImageTextResult } from "./imageTextTypes"
import { ImageTextBlocks } from "./imageTextBlocks"
import { ImageTextHighlights } from "./imageTextHighlights"
import { ImageTextPointer } from "./imageTextPointer"
import { playRecognitionScan } from "./imageTextScan"

interface ImageTextSession {
  token: string
  finish(result: ImageTextResult | null, message?: string): void
  close(): void
}

declare global {
  interface Window {
    __onceImageText?: ImageTextSession
    __onceStartImageText?: (src: string, x: number, y: number, token: string) => boolean
  }
}

/**
 * Registers the overlay's starter in the image's document. The app's thin
 * injection bundles (Electron, Android) call this; it exposes no privileged
 * bridge: native recognition receives only the image chosen from the native
 * menu, and the result is handed back through `__onceImageText.finish`.
 */
export function installImageTextOverlay(): void {
  window.__onceStartImageText = (src, x, y, token) => {
    window.__onceImageText?.close()
    const candidates = [...document.images].filter((image) => (image.currentSrc || image.src) === src)
    const hit = Number.isFinite(x) && Number.isFinite(y)
      ? document.elementsFromPoint(x, y).find((element) => candidates.includes(element as HTMLImageElement))
      : undefined
    // Without a usable point (a touch menu may not report one), take the copy in view.
    const image = hit as HTMLImageElement | undefined ?? (candidates.length === 1 ? candidates[0] : candidates.find(inView))
    if (!image || !image.complete || !image.naturalWidth) return false
    const session = createSelection(image, token)
    window.__onceImageText = session
    return true
  }
}

function inView(image: HTMLImageElement): boolean {
  const rect = image.getBoundingClientRect()
  return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
}

/** The overlay's styles, inside its shadow root. */
const OVERLAY_CSS = `
  :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  /* While open, the overlay takes the image's input (see imageTextPointer.ts). */
  .clip { position: absolute; overflow: hidden; pointer-events: auto; cursor: text;
    user-select: none; -webkit-user-select: none; touch-action: manipulation; }
  .words { position: absolute; transform-origin: 0 0; }
  .word { position: absolute; display: inline-block; color: transparent;
    font-family: Arial, sans-serif; white-space: pre; line-height: 1;
    transform-origin: 0 0; cursor: text; pointer-events: auto;
    user-select: text; -webkit-user-select: text; -webkit-user-drag: none; }
  /* Touch selects through the overlay's own model; native carets would leave it. */
  @media (pointer: coarse) { .word { user-select: none; -webkit-user-select: none; } }
  .handle { position: absolute; width: 20px; height: 20px; margin: 2px 0 0 -10px; border-radius: 50%;
    background: #3984ff; pointer-events: auto; touch-action: none; }
  .handle::before { content: ""; position: absolute; left: 9px; top: -14px; width: 2px; height: 14px; background: #3984ff; }
  .word::selection, .word *::selection { color: transparent; background: transparent; }
  .separator { font-size: 0; }
  .scan { position: absolute; inset: 0; width: 100%; height: 100%; pointer-events: none; }
  .highlights { position: absolute; inset: 0; width: 100%; height: 100%;
    pointer-events: none; user-select: none; fill: #3984ff; fill-opacity: .36; }
  .bar { position: absolute; display: flex; align-items: center; gap: 12px;
    width: max-content; max-width: var(--bar-max-width, calc(100vw - 16px));
    padding: 8px 10px; border: 1px solid #b8bec7;
    border-radius: 8px; box-shadow: 0 2px 10px #0003; color: #20242b;
    background: #fff; font: 13px/1.4 system-ui; pointer-events: auto; user-select: none;
    transition: opacity .15s; }
  /* Out of the way while a sweep passes under it. */
  .bar.sweeping { opacity: .15; pointer-events: none; }
  button { font: inherit; color: inherit; background: transparent; cursor: pointer;
    border: 1px solid #8893a3; border-radius: 5px; padding: 3px 9px; }
  button:focus-visible { outline: 2px solid #3984ff; outline-offset: 2px; }
  @media (prefers-color-scheme: dark) {
    .bar { color: #f1f3f6; background: #252930; border-color: #6f7783; }
  }
`

function createSelection(image: HTMLImageElement, token: string): ImageTextSession {
  const host = document.createElement("div")
  host.dataset.onceImageText = token
  const shadow = host.attachShadow({ mode: "open" })
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(OVERLAY_CSS)
  shadow.adoptedStyleSheets = [sheet]
  const clip = document.createElement("div")
  clip.className = "clip"
  const words = document.createElement("div")
  words.className = "words"
  clip.append(words)
  const highlights = new ImageTextHighlights(shadow, words)
  const blocks = new ImageTextBlocks(shadow, words)
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
  // Touch has no copy shortcut, and an Android browsing surface may draw no
  // selection toolbar, so the bar copies the selection (or all text) itself.
  const touch = matchMedia("(pointer: coarse)").matches
  const copy = document.createElement("button")
  copy.type = "button"
  copy.textContent = "Copy"
  copy.hidden = true
  bar.append(status, copy, done)
  shadow.append(clip, bar)
  const pointer = new ImageTextPointer(shadow, clip, words, image, (sweeping) => bar.classList.toggle("sweeping", sweeping))
  document.documentElement.append(host)
  const originalSource = image.currentSrc || image.src
  let frame = 0
  let closed = false
  let stopScan: () => void = () => undefined
  const close = () => {
    closed = true
    cancelAnimationFrame(frame)
    stopScan()
    document.removeEventListener("keydown", keydown, true)
    highlights.destroy()
    blocks.destroy()
    pointer.destroy()
    host.remove()
    if (window.__onceImageText?.token === token) delete window.__onceImageText
  }
  const keydown = (event: KeyboardEvent) => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); close() }
  }
  document.addEventListener("keydown", keydown, true)
  done.onclick = close
  copy.onclick = () => {
    const hint = status.textContent
    status.textContent = blocks.copyFromGesture() ? "Copied" : "Couldn’t copy the text"
    setTimeout(() => { if (!closed) status.textContent = hint }, 1600)
  }
  const layout = () => {
    if (!image.isConnected || (image.currentSrc || image.src) !== originalSource) { close(); return }
    position(image, clip, words, bar)
    highlights.update()
    pointer.update()
    frame = requestAnimationFrame(layout)
  }
  layout()
  return {
    token, close,
    finish(result, message) {
      if (closed) return
      if (!result?.lines.some((line) => line.length)) {
        status.textContent = message || "No text found in this image"
        return
      }
      renderWords(words, result, image.naturalWidth, image.naturalHeight)
      highlights.attach(image.naturalWidth, image.naturalHeight)
      blocks.attach(result)
      stopScan = playRecognitionScan(image, clip, words)
      // Runs in the page, so the page reports the platform for the copy shortcut.
      copy.hidden = !touch
      status.textContent = touch ? "Tap words to select"
        : `Drag to select text · ${/^Mac/.test(navigator.platform) ? "⌘C" : "Ctrl+C"} to copy`
    }
  }
}

function position(image: HTMLImageElement, clip: HTMLElement, words: HTMLElement, bar: HTMLElement): void {
  const rect = image.getBoundingClientRect()
  const style = getComputedStyle(image)
  const borderX = parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft)
  const borderY = parseFloat(style.borderTopWidth) + parseFloat(style.paddingTop)
  const width = image.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)
  const height = image.clientHeight - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)
  // Account for axis-aligned CSS scaling as well as browser zoom.
  const sx = rect.width / (image.offsetWidth || 1)
  const sy = rect.height / (image.offsetHeight || 1)
  const left = rect.left + borderX * sx, top = rect.top + borderY * sy
  const visibleBox = visibleImageBox(image, left, top, width * sx, height * sy)
  Object.assign(clip.style, { left: `${left}px`, top: `${top}px`,
    clipPath: `inset(${Math.max(0, visibleBox.top - top)}px ${Math.max(0, left + width * sx - visibleBox.right)}px ${Math.max(0, top + height * sy - visibleBox.bottom)}px ${Math.max(0, visibleBox.left - left)}px)`,
    width: `${width * sx}px`, height: `${height * sy}px` })
  const contain = Math.min(width / image.naturalWidth, height / image.naturalHeight)
  const cover = Math.max(width / image.naturalWidth, height / image.naturalHeight)
  const fit = style.objectFit
  const scale = fit === "cover" ? cover : fit === "none" ? 1 : fit === "scale-down" ? Math.min(1, contain) : contain
  const dw = fit === "fill" ? width : image.naturalWidth * scale
  const dh = fit === "fill" ? height : image.naturalHeight * scale
  const positions = style.objectPosition.split(" ")
  const offset = (value: string, remaining: number) => value.endsWith("%") ? parseFloat(value) / 100 * remaining : parseFloat(value) || 0
  Object.assign(words.style, { left: `${offset(positions[0], width - dw) * sx}px`,
    top: `${offset(positions[1] || "50%", height - dh) * sy}px`,
    transform: `scale(${dw * sx / image.naturalWidth}, ${dh * sy / image.naturalHeight})` })
  const visible = visibleBox.bottom > visibleBox.top && visibleBox.right > visibleBox.left
  bar.hidden = clip.hidden = !visible
  if (visible) placeBar(bar, visibleBox, words)
}

interface Box { left: number; top: number; right: number; bottom: number }
const barSpots = new WeakMap<HTMLElement, { key: string; left: number; top: number }>()

/**
 * The bar never hides text where it can help it: it sits just below the
 * image's visible part, or above it, and only on an image filling the viewport
 * takes the inside corner covering the fewest recognized words. Its width is
 * its content's (max-content) capped by the viewport, so placing it never
 * feeds back into its width, and it stays clear of scrollbars.
 */
function placeBar(bar: HTMLElement, box: Box, words: HTMLElement): void {
  const view = viewport(), gap = 8
  bar.style.setProperty("--bar-max-width", `${view.width - gap * 2}px`)
  const w = bar.offsetWidth, h = bar.offsetHeight
  const key = [box.left, box.top, box.right, box.bottom, w, h, view.width, view.height, words.childElementCount].map(Math.round).join()
  let spot = barSpots.get(bar)
  if (spot?.key !== key) {
    const x = (left: number) => Math.max(gap, Math.min(left, view.width - w - gap))
    const y = (top: number) => Math.max(gap, Math.min(top, view.height - h - gap))
    let place = box.bottom + gap + h <= view.height - gap ? { left: x(box.right - w), top: box.bottom + gap }
      : box.top - gap - h >= gap ? { left: x(box.right - w), top: box.top - gap - h } : null
    if (!place) {
      const rects = [...words.querySelectorAll(".word")].map((word) => word.getBoundingClientRect())
      const covered = (left: number, top: number) => rects.reduce((sum, r) => sum +
        Math.max(0, Math.min(r.right, left + w) - Math.max(r.left, left)) * Math.max(0, Math.min(r.bottom, top + h) - Math.max(r.top, top)), 0)
      place = [[box.right - w - gap, box.bottom - h - gap], [box.left + gap, box.bottom - h - gap],
        [box.right - w - gap, box.top + gap], [box.left + gap, box.top + gap]]
        .map(([left, top]) => ({ left: x(left), top: y(top) }))
        .reduce((best, corner) => covered(corner.left, corner.top) < covered(best.left, best.top) ? corner : best)
    }
    spot = { key, ...place }
    barSpots.set(bar, spot)
  }
  bar.style.left = `${spot.left}px`
  bar.style.top = `${spot.top}px`
}

/**
 * The viewport without scrollbars (innerWidth/innerHeight include them). The
 * scrolling element reports it in standards and quirks mode alike; a
 * standalone image document is a quirks-mode page.
 */
function viewport() {
  const root = document.scrollingElement ?? document.documentElement
  return { width: root.clientWidth || innerWidth, height: root.clientHeight || innerHeight }
}

/** A fixed overlay must obey the image's scrolling/clipping ancestors too. */
function visibleImageBox(image: HTMLElement, left: number, top: number, width: number, height: number) {
  const view = viewport()
  const box = { left: Math.max(0, left), top: Math.max(0, top),
    right: Math.min(view.width, left + width), bottom: Math.min(view.height, top + height) }
  for (let parent = image.parentElement; parent; parent = parent.parentElement) {
    const style = getComputedStyle(parent), rect = parent.getBoundingClientRect()
    if (/(hidden|clip|scroll|auto)/.test(style.overflowX)) {
      box.left = Math.max(box.left, rect.left + parent.clientLeft)
      box.right = Math.min(box.right, rect.left + parent.clientLeft + parent.clientWidth)
    }
    if (/(hidden|clip|scroll|auto)/.test(style.overflowY)) {
      box.top = Math.max(box.top, rect.top + parent.clientTop)
      box.bottom = Math.min(box.bottom, rect.top + parent.clientTop + parent.clientHeight)
    }
  }
  return box
}

function renderWords(container: HTMLElement, result: ImageTextResult, width: number, height: number): void {
  container.replaceChildren()
  for (const [lineIndex, line] of result.lines.entries()) {
    for (const word of line) {
      const span = document.createElement("span")
      span.className = "word"
      span.dataset.line = String(lineIndex)
      span.textContent = word.text
      const dx = (word.topRight.x - word.topLeft.x) * width
      const dy = (word.topRight.y - word.topLeft.y) * height
      const boxWidth = Math.hypot(dx, dy)
      const boxHeight = Math.hypot((word.bottomLeft.x - word.topLeft.x) * width,
        (word.bottomLeft.y - word.topLeft.y) * height)
      Object.assign(span.style, { left: `${word.topLeft.x * width}px`, top: `${word.topLeft.y * height}px`,
        fontSize: `${boxHeight}px`, height: `${boxHeight}px` })
      container.append(span)
      const measured = span.getBoundingClientRect().width
      // Measure unscaled glyphs: the parent is already fitted to the displayed image.
      const natural = span.offsetWidth || measured || 1
      span.style.transform = `rotate(${Math.atan2(dy, dx)}rad) scaleX(${boxWidth / natural})`
      // Keep copy separators in DOM order without extending the fitted glyph
      // rectangle into the next word's selection highlight.
      const separator = document.createElement("span")
      separator.className = "separator"
      separator.textContent = " "
      span.append(separator)
    }
    container.append(document.createTextNode("\n"))
  }
}
