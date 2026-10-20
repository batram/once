import type { ImageTextFit, ImageTextResult, ImageTextWord } from "./imageTextTypes"

/**
 * Android's touch selection: native Gecko carets, handles, magnifier and
 * toolbar over the recognized text. The words live in an iframe over the image,
 * so a selection can never run into the page's own text, and the iframe sits in
 * the page's coordinates, so it scrolls and zooms with the page natively.
 *
 * In a document of the app's own (Android's out-of-page overlay view, see
 * imageTextView.ts) the layer goes inline instead: there is no page to keep it
 * from, and Chromium's touch selection does not reach into such a frame.
 *
 * Gecko's carets only behave over a gapless layer laid out to their rules:
 * - a caret drag resolves points through in-flow children by their frame
 *   rects: absolutely positioned lines are invisible to it (the selection jumps
 *   to the start) and relatively positioned ones are found at their unshifted
 *   place, so every line is a grid item in one shared cell, placed by margins;
 * - a point in a line's padding, or above or below its line box, snaps to the
 *   line's start or end, so each line box itself reaches halfway to the next
 *   line of its column (or to the edge), and words fill a line with spacers;
 * - a long press only selects when it hits a text frame, so each transparent
 *   word is stretched vertically into part of that gap.
 */

const FRAME_CSS = `
  /* Anchored at the page's origin; below the overlay's bar, which shares the topmost z-index. */
  :host { all: initial; position: absolute; left: 0; top: 0; width: 0; height: 0; z-index: 2147483646; }
  iframe { all: initial; position: absolute; display: block; border: 0; margin: 0; padding: 0;
    background: transparent; color-scheme: light; }
  iframe[hidden] { display: none; }
`

const FRAME_DOCUMENT_CSS = `
  :root, body { margin: 0; padding: 0; height: 100%; overflow: clip; background: transparent; }
  /* Must match the iframe's or it paints opaque; \`normal\` resolves differently on each side under a dark preference. */
  :root:root { color-scheme: light !important; }
`

const INLINE_CSS = `
  .layer { position: absolute; overflow: clip; }
  .layer[hidden] { display: none; }
`

const LAYER_CSS = `
  .layer { display: grid; grid-template: 100% / 100%; color: transparent; font-family: Arial, sans-serif;
    cursor: text; -webkit-tap-highlight-color: transparent;
    -moz-text-size-adjust: none; -webkit-text-size-adjust: none; text-size-adjust: none; }
  .line { grid-area: 1 / 1; justify-self: start; align-self: start; width: max-content; white-space: pre; }
  .cell { display: inline-block; vertical-align: top; white-space: pre; }
  .word, .space { display: inline-block; transform-origin: 0 0; }
  ::selection { color: transparent; background: rgb(57 132 255 / 38%); }
`

interface Line {
  index: number
  words: { word: ImageTextWord; left: number; right: number }[]
  left: number
  right: number
  top: number
  bottom: number
  padTop: number
  padBottom: number
}

export class ImageTextLayer {
  private readonly host = document.createElement("div")
  /** The iframe holding the layer in a page; null when the layer is inline in the app's own document. */
  private readonly frame: HTMLIFrameElement | null
  /** The element placed over the image: the iframe, or the inline layer itself. */
  private readonly box: HTMLElement
  private readonly layer: HTMLElement
  private readonly doc: Document
  private result: ImageTextResult | null = null
  private placement = ""
  private geometry = ""

  constructor(token: string, { inline = false } = {}) {
    this.host.dataset.onceImageTextLayer = token
    if (inline) {
      // The app's own document: the layer is part of it, where selections and copies are plain.
      this.frame = null
      this.doc = document
      this.layer = this.box = this.host
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(INLINE_CSS + LAYER_CSS)
      document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet]
      document.body.append(this.layer)
    } else {
      const shadow = this.host.attachShadow({ mode: "closed" })
      const sheet = new CSSStyleSheet()
      sheet.replaceSync(FRAME_CSS)
      shadow.adoptedStyleSheets = [sheet]
      document.documentElement.append(this.host)
      this.frame = this.box = document.createElement("iframe")
      this.frame.title = "Recognized text"
      shadow.append(this.frame)
      // The initial about:blank document: built through the DOM, so a page's
      // CSP (which it inherits) never sees an inline style or script.
      this.doc = this.frame.contentDocument as Document
      const view = this.frame.contentWindow as Window & typeof globalThis
      const layerSheet = new view.CSSStyleSheet()
      layerSheet.replaceSync(FRAME_DOCUMENT_CSS + LAYER_CSS)
      this.doc.adoptedStyleSheets = [layerSheet]
      this.layer = this.doc.body
    }
    this.layer.classList.add("layer")
    this.box.hidden = true
  }

  /** The element holding the `.word` spans (each with `data-line`), for copying and reflow. */
  get words(): HTMLElement {
    return this.layer
  }

  show(result: ImageTextResult): void {
    this.result = result
    this.geometry = ""
  }

  /** The selection inside the layer, or null. */
  range(): Range | null {
    const selection = this.doc.getSelection()
    return selection && selection.rangeCount && !selection.isCollapsed ? selection.getRangeAt(0) : null
  }

  /** Word boxes in the page's viewport pixels, in reading order. */
  wordRects(): DOMRect[] {
    const origin = this.frame ? this.frame.getBoundingClientRect() : { left: 0, top: 0 }
    return [...this.layer.querySelectorAll(".word")].map((word) => {
      const rect = (word.parentElement ?? word).getBoundingClientRect()
      return new DOMRect(origin.left + rect.left, origin.top + rect.top, rect.width, rect.height)
    })
  }

  /** Each layout frame: follow the image, and re-lay the words when its drawn size changes. */
  update(fit: ImageTextFit): void {
    this.box.hidden = !this.result || !fit.visible
    if (this.box.hidden) return
    // A frame is placed from its host, at the page origin; an inline layer from its own document origin.
    const origin = this.frame ? this.host.getBoundingClientRect() : { left: 0, top: 0 }
    const placement = [fit.left - origin.left, fit.top - origin.top, fit.width, fit.height].map((value) => `${value}px`)
    const key = placement.join() + fit.clipPath
    if (key !== this.placement) {
      this.placement = key
      const [left, top, width, height] = placement
      Object.assign(this.box.style, { left, top, width, height, clipPath: fit.clipPath })
    }
    const geometry = [fit.width, fit.height, fit.imageLeft, fit.imageTop, fit.imageWidth, fit.imageHeight]
      .map((value) => Math.round(value * 2) / 2).join()
    if (geometry !== this.geometry) {
      this.geometry = geometry
      this.render(fit)
    }
  }

  destroy(): void {
    this.host.remove()
  }

  private render(fit: ImageTextFit): void {
    const body = this.layer
    body.replaceChildren()
    if (!this.result) return
    const inks: { ink: HTMLElement; width: number; lift: number; stretch: number }[] = []
    for (const line of lineBoxes(this.result, fit)) {
      const height = line.bottom - line.top
      // The line box spans the whole padded band; words keep their own height inside it.
      const band = line.padTop + height + line.padBottom
      const element = this.element("div", "line", {
        marginLeft: `${line.left}px`, marginTop: `${line.top - line.padTop}px`, height: `${band}px`,
        lineHeight: `${band}px`, fontSize: `${height * 0.82}px` })
      const grow = { up: Math.min(line.padTop, height / 2), down: Math.min(line.padBottom, height / 2) }
      const stretch = (height + grow.up + grow.down) / height
      let x = line.left
      line.words.forEach(({ word, left, right }, index) => {
        if (index > 0) {
          // Measured from where layout actually is, so overlapping OCR boxes never drift.
          const gap = Math.max(0.5, left - x)
          inks.push({ ink: this.cell(element, "space", " ", gap, line.padTop, height), width: gap, lift: grow.up, stretch })
          x += gap
        }
        const width = Math.max(1, right - left)
        const ink = this.cell(element, "word", word.text, width, line.padTop, height)
        ink.dataset.line = String(line.index)
        inks.push({ ink, width, lift: grow.up, stretch })
        x += width
      })
      body.append(element)
    }
    // Fit each word to its box from laid-out glyphs: the font that renders is
    // whatever the platform substitutes, so a canvas measure would leave seams.
    const natural = inks.map(({ ink }) => ink.offsetWidth || 1)
    inks.forEach(({ ink, width, lift, stretch }, index) => {
      ink.style.transform = `translateY(${-lift}px) scale(${width / natural[index]}, ${stretch})`
    })
  }

  private cell(line: HTMLElement, kind: string, text: string, width: number, top: number, height: number): HTMLElement {
    const cell = this.element("span", "cell", { width: `${width}px`, marginTop: `${top}px`, lineHeight: `${height}px` })
    const ink = this.element("span", kind, {})
    ink.textContent = text
    cell.append(ink)
    line.append(cell)
    return ink
  }

  private element(tag: string, className: string, style: Partial<CSSStyleDeclaration>): HTMLElement {
    const element = this.doc.createElement(tag)
    element.className = className
    Object.assign(element.style, style)
    return element
  }
}

/** Axis-aligned line boxes in layer pixels, padded halfway towards the neighbouring lines of their column. */
function lineBoxes(result: ImageTextResult, fit: ImageTextFit): Line[] {
  const x = (value: number) => fit.imageLeft + value * fit.imageWidth
  const y = (value: number) => fit.imageTop + value * fit.imageHeight
  const lines: Line[] = []
  result.lines.forEach((line, index) => {
    if (!line.length) return
    const words = line.map((word) => {
      const xs = [word.topLeft.x, word.topRight.x, word.bottomLeft.x, word.topRight.x + word.bottomLeft.x - word.topLeft.x].map(x)
      return { word, left: Math.min(...xs), right: Math.max(...xs) }
    })
    const ys = line.flatMap((word) => [word.topLeft.y, word.topRight.y, word.bottomLeft.y, word.topRight.y + word.bottomLeft.y - word.topLeft.y]).map(y)
    lines.push({ index, words, left: Math.min(...words.map((word) => word.left)), right: Math.max(...words.map((word) => word.right)),
      top: Math.min(...ys), bottom: Math.max(...ys), padTop: 0, padBottom: 0 })
  })
  for (const line of lines) {
    const height = line.bottom - line.top
    const column = lines.filter((other) => other !== line && Math.min(other.right, line.right) > Math.max(other.left, line.left))
    const above = Math.max(-Infinity, ...column.filter((other) => other.bottom <= line.top + height * 0.3).map((other) => other.bottom))
    const below = Math.min(Infinity, ...column.filter((other) => other.top >= line.bottom - height * 0.3).map((other) => other.top))
    line.padTop = Number.isFinite(above) ? Math.max(0, line.top - above) / 2 : Math.max(0, line.top)
    line.padBottom = Number.isFinite(below) ? Math.max(0, below - line.bottom) / 2 : Math.max(0, fit.height - line.bottom)
  }
  return lines
}

