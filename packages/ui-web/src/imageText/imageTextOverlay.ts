import { ocrParagraphLines } from "@once/app/ocrParagraphs"
import type { ImageTextFit, ImageTextPoint, ImageTextResult, ImageTextWord } from "./imageTextTypes"
import { ImageTextBlocks } from "./imageTextBlocks"
import { uncoveredBox } from "./imageTextCover"
import { ImageTextHighlights, selectionRange } from "./imageTextHighlights"
import { ImageTextLayer } from "./imageTextLayer"
import { ImageTextPointer } from "./imageTextPointer"
import { playRecognitionScan } from "./imageTextScan"

export interface ImageTextSession {
  token: string
  finish(result: ImageTextResult | null, message?: string): void
  /** The text Copy takes: the selection, reflowed, or all recognized text. */
  copyText(): string
  /** What the bar says. */
  statusText(): string
  close(): void
}

/** What the app's own bar shows for a selection (see `bar` below); null once it closed. */
export interface ImageTextBarState { status: string; copy: boolean }

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
 * `textLayer` (Android) selects with the engine's native touch carets over an
 * `ImageTextLayer` instead of the overlay's own pointer model. `bar` (Android)
 * is the app's own native bar: the page then gets none, and the overlay
 * reports what that bar shows instead.
 */
export function installImageTextOverlay({ textLayer = false, bar }: {
  textLayer?: boolean
  bar?: (token: string, state: ImageTextBarState | null) => void
} = {}): void {
  window.__onceStartImageText = (src, x, y, token) => {
    window.__onceImageText?.close()
    const image = findImage(src, x, y)
    if (!image) return false
    const session = createSelection(image, token, textLayer, bar)
    window.__onceImageText = session
    return true
  }
}

/** The loaded image the native menu was opened on: by source, at the menu's point when it has one. */
export function findImage(src: string, x: number, y: number): HTMLImageElement | null {
  const candidates = [...document.images].filter((image) => (image.currentSrc || image.src) === src)
  const hit = Number.isFinite(x) && Number.isFinite(y)
    ? document.elementsFromPoint(x, y).find((element) => candidates.includes(element as HTMLImageElement))
    : undefined
  // Without a usable point (a touch menu may not report one), take the copy in view.
  const image = hit as HTMLImageElement | undefined ?? (candidates.length === 1 ? candidates[0] : candidates.find(inView))
  return image && image.complete && image.naturalWidth ? image : null
}

/** The overlay's own elements, which sit over the image and are no page UI covering it. */
function ownElement(element: Element): boolean {
  return Boolean(element.closest("[data-once-image-text], [data-once-image-text-layer]"))
}

function inView(image: HTMLImageElement): boolean {
  const rect = image.getBoundingClientRect()
  return rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
}

/** The overlay's styles, inside its shadow root. */
export const OVERLAY_CSS = `
  :host { all: initial; position: fixed; inset: 0; z-index: 2147483647; pointer-events: none; }
  * { box-sizing: border-box; }
  [hidden] { display: none !important; }
  /* While open, the overlay takes the image's input (see imageTextPointer.ts). */
  .clip { position: absolute; overflow: hidden; pointer-events: auto; cursor: text;
    user-select: none; -webkit-user-select: none; touch-action: manipulation; }
  /* Over Android's text layer the clip only carries the recognition flourish. */
  .clip.passive { pointer-events: none; }
  .words { position: absolute; transform-origin: 0 0; }
  /* One block per recognized paragraph with its words inline in it, so find
     in page matches across words and wrapped lines as in page text (see renderWords). */
  .line { position: absolute; white-space: pre; line-height: 1; transform-origin: 0 0;
    font-family: Arial, sans-serif; color: transparent; }
  .word { position: relative; vertical-align: top; cursor: text; pointer-events: auto;
    letter-spacing: var(--once-word-spacing, 0); margin-left: var(--once-word-gap, 0);
    user-select: text; -webkit-user-select: text; -webkit-user-drag: none; }
  .separator { user-select: text; -webkit-user-select: text; }
  /* Touch selects through the overlay's own model; native carets would leave it. */
  @media (pointer: coarse) { .word, .separator { user-select: none; -webkit-user-select: none; } }
  .handle { position: absolute; width: 20px; height: 20px; margin: 2px 0 0 -10px; border-radius: 50%;
    background: #3984ff; pointer-events: auto; touch-action: none; }
  .handle::before { content: ""; position: absolute; left: 9px; top: -14px; width: 2px; height: 14px; background: #3984ff; }
  .word::selection, .separator::selection { color: transparent; background: transparent; }
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

export function createSelection(image: HTMLImageElement, token: string, textLayer: boolean,
  appBar?: (token: string, state: ImageTextBarState | null) => void, onClose?: () => void): ImageTextSession {
  const host = document.createElement("div")
  host.dataset.onceImageText = token
  // Closed: the page's scripts cannot reach in to read or change the recognized words.
  const shadow = host.attachShadow({ mode: "closed" })
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(OVERLAY_CSS)
  shadow.adoptedStyleSheets = [sheet]
  const clip = document.createElement("div")
  clip.className = "clip"
  const words = document.createElement("div")
  words.className = "words"
  clip.append(words)
  // Android's layer selects natively and paints its own selection.
  const layer = textLayer ? new ImageTextLayer(token) : null
  clip.classList.toggle("passive", Boolean(layer))
  const highlights = layer ? null : new ImageTextHighlights(shadow, words)
  const blocks = layer ? new ImageTextBlocks(layer.words, () => layer.range())
    : new ImageTextBlocks(words, () => selectionRange(shadow))
  const wordRects = () => layer ? layer.wordRects()
    : [...words.querySelectorAll(".word")].map((word) => word.getBoundingClientRect())
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
  // Touch has no copy shortcut, and a touch selection may draw no toolbar, so
  // the bar copies the selection (or all text, when nothing is selected) itself.
  const touch = Boolean(layer) || matchMedia("(pointer: coarse)").matches
  const copy = document.createElement("button")
  copy.type = "button"
  copy.textContent = "Copy"
  copy.hidden = true
  bar.append(status, copy, done)
  shadow.append(clip)
  if (!appBar) shadow.append(bar)
  const show = (text: string, offerCopy = !copy.hidden) => {
    status.textContent = text
    copy.hidden = !offerCopy
    appBar?.(token, { status: text, copy: offerCopy })
  }
  show(status.textContent)
  const pointer = layer ? null
    : new ImageTextPointer(shadow, clip, words, image, (sweeping) => bar.classList.toggle("sweeping", sweeping))
  document.documentElement.append(host)
  const originalSource = image.currentSrc || image.src
  let frame = 0
  let rendered = 0 // words shown so far: the bar's spot depends on them
  let closed = false
  let stopScan: () => void = () => undefined
  const close = () => {
    closed = true
    cancelAnimationFrame(frame)
    stopScan()
    document.removeEventListener("keydown", keydown, true)
    highlights?.destroy()
    blocks.destroy()
    pointer?.destroy()
    layer?.destroy()
    host.remove()
    if (window.__onceImageText?.token === token) delete window.__onceImageText
    appBar?.(token, null)
    onClose?.()
  }
  const keydown = (event: KeyboardEvent) => {
    // The page's own script cannot close the selection with a synthetic key.
    if (event.key === "Escape" && event.isTrusted) { event.preventDefault(); event.stopPropagation(); close() }
  }
  document.addEventListener("keydown", keydown, true)
  done.onclick = close
  copy.onclick = () => {
    const hint = status.textContent
    status.textContent = blocks.copyFromGesture() ? "Copied" : "Couldn’t copy the text"
    setTimeout(() => { if (!closed) status.textContent = hint }, 1600)
  }
  const place = () => {
    // Clipped to what the page does not draw over, so the selection never shows through its UI.
    const fit = imageFit(image, (box) => uncoveredBox(image, box, ownElement))
    position(image, fit, clip, words)
    layer?.update(fit)
    bar.hidden = clip.hidden = !fit.visible
    if (fit.visible && !appBar) placeBar(bar, fit.visibleBox, wordRects, rendered)
  }
  const layout = () => {
    if (!image.isConnected || (image.currentSrc || image.src) !== originalSource) { close(); return }
    place()
    highlights?.update()
    pointer?.update()
    frame = requestAnimationFrame(layout)
  }
  layout()
  return {
    token, close,
    copyText: () => blocks.copyText(), statusText: () => status.textContent ?? "",
    finish(result, message) {
      if (closed) return
      if (!result?.lines.some((line) => line.length)) {
        show(message || "No text found in this image")
        return
      }
      if (layer) layer.show(result)
      else renderWords(words, result, image.naturalWidth, image.naturalHeight)
      highlights?.attach(image.naturalWidth, image.naturalHeight)
      blocks.attach(result)
      rendered++
      // Lay the words out now, so the flourish measures them.
      place()
      stopScan = playRecognitionScan(image, clip, wordRects)
      // Runs in the page, so the page reports the platform for the copy shortcut.
      show(layer ? "Double-tap or long-press text" : touch ? "Tap words to select"
        : `Drag to select text · ${/^Mac/.test(navigator.platform) ? "⌘C" : "Ctrl+C"} to copy`, touch)
    }
  }
}

/**
 * Where an image's content box and its drawn picture are this frame. An
 * iframe (Electron's overlay places images inside frames through their
 * owners) fills its content box.
 */
export function imageFit(image: HTMLImageElement | HTMLIFrameElement, clip?: (box: ImageTextFit["visibleBox"]) => ImageTextFit["visibleBox"]): ImageTextFit {
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
  const scrolled = visibleImageBox(image, left, top, width * sx, height * sy)
  const visibleBox = clip && scrolled.right > scrolled.left && scrolled.bottom > scrolled.top ? clip(scrolled) : scrolled
  const clipPath = `inset(${Math.max(0, visibleBox.top - top)}px ${Math.max(0, left + width * sx - visibleBox.right)}px ` +
    `${Math.max(0, top + height * sy - visibleBox.bottom)}px ${Math.max(0, visibleBox.left - left)}px)`
  const natural = "naturalWidth" in image ? { width: image.naturalWidth, height: image.naturalHeight } : null
  const fit = natural ? style.objectFit : "fill"
  const contain = natural ? Math.min(width / natural.width, height / natural.height) : 1
  const cover = natural ? Math.max(width / natural.width, height / natural.height) : 1
  const scale = fit === "cover" ? cover : fit === "none" ? 1 : fit === "scale-down" ? Math.min(1, contain) : contain
  const dw = fit === "fill" || !natural ? width : natural.width * scale
  const dh = fit === "fill" || !natural ? height : natural.height * scale
  const positions = style.objectPosition.split(" ")
  const offset = (value: string, remaining: number) => value.endsWith("%") ? parseFloat(value) / 100 * remaining : parseFloat(value) || 0
  return { left, top, width: width * sx, height: height * sy, clipPath, visibleBox,
    visible: visibleBox.bottom > visibleBox.top && visibleBox.right > visibleBox.left,
    imageLeft: offset(positions[0], width - dw) * sx, imageTop: offset(positions[1] || "50%", height - dh) * sy,
    imageWidth: dw * sx, imageHeight: dh * sy }
}

/** Fits the overlay's clip, and the words inside it, to the image. */
function position(image: HTMLImageElement, fit: ImageTextFit, clip: HTMLElement, words: HTMLElement): void {
  Object.assign(clip.style, { left: `${fit.left}px`, top: `${fit.top}px`, clipPath: fit.clipPath,
    width: `${fit.width}px`, height: `${fit.height}px` })
  Object.assign(words.style, { left: `${fit.imageLeft}px`, top: `${fit.imageTop}px`,
    transform: `scale(${fit.imageWidth / image.naturalWidth}, ${fit.imageHeight / image.naturalHeight})` })
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
function placeBar(bar: HTMLElement, box: Box, wordRects: () => DOMRect[], rendered: number): void {
  const view = viewport(), gap = 8
  bar.style.setProperty("--bar-max-width", `${view.width - gap * 2}px`)
  // Fractional size: offsetWidth rounds down and pushes the bar past the margin.
  const { width: w, height: h } = bar.getBoundingClientRect()
  const key = [box.left, box.top, box.right, box.bottom, w, h, view.width, view.height, rendered].map(Math.round).join()
  let spot = barSpots.get(bar)
  if (spot?.key !== key) {
    const x = (left: number) => Math.max(gap, Math.min(left, view.width - w - gap))
    const y = (top: number) => Math.max(gap, Math.min(top, view.height - h - gap))
    let place = box.bottom + gap + h <= view.height - gap ? { left: x(box.right - w), top: box.bottom + gap }
      : box.top - gap - h >= gap ? { left: x(box.right - w), top: box.top - gap - h } : null
    if (!place) {
      const rects = wordRects()
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
export function viewport() {
  const root = document.scrollingElement ?? document.documentElement
  return { width: root.clientWidth || innerWidth, height: root.clientHeight || innerHeight }
}

/**
 * A fixed overlay must obey the image's scrolling/clipping ancestors too. The
 * root's overflow (and body's, when propagated) belongs to the viewport, which
 * is already applied: its clientHeight is the viewport's while its rect starts
 * at -scrollY, so treating it as a clipper hides every image below the fold.
 * An ancestor with `display: contents` has no box, so its overflow clips
 * nothing (Framer sites set `overflow: clip` on one); its rect is empty.
 */
function visibleImageBox(image: HTMLElement, left: number, top: number, width: number, height: number) {
  const view = viewport()
  const box = { left: Math.max(0, left), top: Math.max(0, top),
    right: Math.min(view.width, left + width), bottom: Math.min(view.height, top + height) }
  const root = document.documentElement
  const viewportBody = getComputedStyle(root).overflow === "visible" ? document.body : null
  for (let parent = image.parentElement; parent && parent !== root; parent = parent.parentElement) {
    if (parent === viewportBody) continue
    const style = getComputedStyle(parent)
    if (style.display === "contents") continue
    const rect = parent.getBoundingClientRect()
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

/**
 * Lays the recognized words over the picture, in its natural pixels. Each
 * paragraph is one block, turned to its first line's angle, holding its
 * words as plain inline text with a real space between them, its wrapped
 * lines included: find in page searches a block as one run of text, so
 * "cost of" matches across two words, and across a line break, as in page
 * text. (A block per word kept every match inside one word; a block per
 * line, every match inside one line.)
 * A word reaches its box through letter spacing (the glyphs are transparent;
 * only where its characters fall matters), a left margin and a nudge across
 * the block, since inline text cannot be transformed. The block stays one
 * line of layout: a later line's first word goes back to the line's start
 * with a negative margin, and down by its nudge.
 */
export function renderWords(container: HTMLElement, result: ImageTextResult, width: number, height: number): void {
  container.replaceChildren()
  const blocks = flows(result, width, height).map((lines) => {
    const rendered = renderFlow(lines.map((line) => ({ line, words: result.lines[line] })), width, height)
    container.append(rendered.block, document.createTextNode("\n"))
    return rendered
  })
  // Every natural width in one layout, then every fit. The container and the
  // blocks lie flat and unscaled while they are measured, so the rects are in
  // image pixels: a turned block's rects are its bounds, and the container is
  // already scaled to the drawn image when a selection reopens on it.
  const scaled = container.style.transform
  container.style.transform = "none"
  blocks.forEach((rendered) => { rendered.block.style.transform = "none" })
  const fits = blocks.map((rendered) => rendered.measure())
  blocks.forEach((rendered) => { rendered.block.style.transform = rendered.rotation })
  container.style.transform = scaled
  fits.forEach((fit) => fit())
}

/** Lines' indices by paragraph, each paragraph cut where a line turns away from its first (a page bent in a photo). */
function flows(result: ImageTextResult, width: number, height: number): number[][] {
  const angle = (line: number) => {
    const [{ topLeft, topRight }] = result.lines[line]
    return Math.atan2((topRight.y - topLeft.y) * height, (topRight.x - topLeft.x) * width)
  }
  const paragraphs = ocrParagraphLines({ lines: result.textLines, lineBounds: result.lineBounds })
  const grouped = new Set(paragraphs.flat())
  // Lines with words the grouping passed over stand alone, in their place.
  result.lines.forEach((words, line) => { if (words.length && !grouped.has(line)) paragraphs.push([line]) })
  paragraphs.sort((a, b) => a[0] - b[0])
  return paragraphs.flatMap((lines) => lines.filter((line) => result.lines[line]?.length)
    .reduce<number[][]>((cut, line) => {
      const flow = cut.at(-1)
      if (flow && Math.abs(angle(line) - angle(flow[0])) < 0.03) flow.push(line)
      else cut.push([line])
      return cut
    }, []))
}

function renderFlow(lines: { line: number; words: ImageTextWord[] }[], width: number, height: number) {
  const point = (corner: ImageTextPoint) => ({ x: corner.x * width, y: corner.y * height })
  const first = lines[0].words[0]
  const origin = point(first.topLeft), towards = point(first.topRight)
  const length = Math.hypot(towards.x - origin.x, towards.y - origin.y) || 1
  // The first line's direction, and across it, downwards on upright text.
  const along = { x: (towards.x - origin.x) / length, y: (towards.y - origin.y) / length }
  const across = { x: -along.y, y: along.x }
  const boxes = lines.flatMap(({ line, words }) => words.map((word) => {
    const topLeft = point(word.topLeft), topRight = point(word.topRight), bottomLeft = point(word.bottomLeft)
    const offset = { x: topLeft.x - origin.x, y: topLeft.y - origin.y }
    return { line, text: word.text, start: offset.x * along.x + offset.y * along.y, shift: offset.x * across.x + offset.y * across.y,
      width: Math.hypot(topRight.x - topLeft.x, topRight.y - topLeft.y),
      height: Math.hypot(bottomLeft.x - topLeft.x, bottomLeft.y - topLeft.y) }
  }))
  const block = document.createElement("div")
  block.className = "line"
  const rotation = `rotate(${Math.atan2(along.y, along.x)}rad)`
  Object.assign(block.style, { left: `${origin.x}px`, top: `${origin.y}px`,
    // The spaces' size: the paragraph's typical word height.
    fontSize: `${boxes.reduce((sum, box) => sum + box.height, 0) / boxes.length}px`, transform: rotation })
  const spans = boxes.map((box, index) => {
    // One space between words, and between a line and the next: "wraps onto" + "a line" reads "onto a line".
    if (index) {
      const separator = document.createElement("span")
      separator.className = "separator"
      separator.textContent = " "
      block.append(separator)
    }
    const span = document.createElement("span")
    span.className = "word"
    span.dataset.line = String(box.line)
    span.textContent = box.text
    Object.assign(span.style, { fontSize: `${box.height}px`, top: `${box.shift}px` })
    block.append(span)
    return span
  })
  // A space after the paragraph too: a selection running into the next one reads "words Native", not "wordsNative".
  const trailing = document.createElement("span")
  trailing.className = "separator"
  trailing.textContent = " "
  block.append(trailing)
  // Measured once the caller has laid the block out, flat; the fit it returns then writes.
  const measure = () => {
    // Fractional widths (the caller has laid the block out flat and unscaled):
    // offsetWidth rounds, and each word's place follows the one before, so
    // twenty rounded words put a paragraph's later lines pixels off.
    const width = (element: Element) => element.getBoundingClientRect().width
    const natural = spans.map(width)
    const gaps = [...block.querySelectorAll<HTMLElement>(".separator")].map(width)
    return () => {
      let end = 0
      spans.forEach((span, index) => {
        const box = boxes[index]
        // Spacing follows every character, the last one too: the word then ends where its box does.
        // Set on every word, so none inherits a page's own value of the same name.
        span.style.setProperty("--once-word-spacing", `${(box.width - natural[index]) / Math.max(1, [...box.text].length)}px`)
        span.style.setProperty("--once-word-gap", `${index ? box.start - end - gaps[index - 1] : 0}px`)
        end = box.start + box.width
      })
    }
  }
  return { block, rotation, measure }
}
