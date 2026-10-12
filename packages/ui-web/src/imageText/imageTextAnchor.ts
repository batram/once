import { uncoveredBox } from "./imageTextCover"
import { findImage, imageFit, OVERLAY_CSS, viewport } from "./imageTextOverlay"
import { scrollContainer } from "./imageTextPointer"
import type { ImageTextFit, ImageTextViewEvent, ImageTextViewLayout, ImageTextViewMessage } from "./imageTextTypes"

// Electron's image text selection, held in the page by the page's own
// compositor. The app runs this in an isolated world of the image's frame
// (see its browser/ImageTextHost.ts): it hangs two closed hosts in the
// document, tied to the image with CSS anchor positioning, so every scroll
// moves them in the same frame as the image, on the compositor thread,
// through any scrolling ancestors and frames. App-owned views over the tab
// could only follow a frame later.
//
// The words are in a cross-origin frame of the app's own (the
// `once-image-text:` scheme): the page cannot read or restyle them, nor the
// selection or what is copied. All the page sees is two opaque elements and
// an extra anchor name on its image. The bar (status and Done) has nothing
// private and lives in the second host's closed shadow root.

/** What this world pushes through the app's binding: the selection closed on its own (Done, Escape, the image went). */
export interface ImageTextAnchorReport { token: string; closed: true }

/** For the app's tests: where the parts are, in the viewport. */
export interface ImageTextAnchorState {
  frame: { left: number; top: number; width: number; height: number }
  clipPath: string
  hidden: boolean
  bar: { left: number; top: number; right: number; bottom: number; text: string; background: string; mode: string } | null
}

declare global {
  interface Window {
    __onceImageTextAnchor?: {
      start(token: string, src: string, x: number, y: number, frameUrl: string): boolean
      message(token: string, message: ImageTextViewMessage): void
      alive(token: string): boolean
      stop(token: string): void
      state(token: string): ImageTextAnchorState | null
    }
  }
}

const GAP = 8

/** Host styles, inline and important: the page's own sheets cannot move, hide or restyle them. */
function hostStyle(declarations: string[]): string {
  return ["all: initial", "display: block", "margin: 0", "padding: 0", "border: 0",
    "pointer-events: none", ...declarations].map((declaration) => `${declaration} !important`).join("; ")
}

/** The bar is the app's control and stays readable over everything. */
const BAR_LAYER = "z-index: 2147483647"

const FRAME_CSS = `
  iframe { position: absolute; display: block; border: 0; margin: 0; padding: 0; background: transparent;
    pointer-events: auto; color-scheme: normal; }
  .bar { left: 0; top: 0; }
`

type Box = ImageTextFit["visibleBox"]
type BarSpot = { left: number; top: number; mode: "hidden" | "fixed" | "below" | "above" }

let current: AnchoredSelection | null = null

function pusher(): ((payload: string) => void) | undefined {
  return (globalThis as { __onceImageTextPush?: (payload: string) => void }).__onceImageTextPush ?? window.__onceImageTextPush
}

/** The app's own hosts over the image, which are no page UI covering it. */
function ownElement(element: Element): boolean {
  return Boolean(element.closest("[data-once-image-text]"))
}

function closedHost(css: string): { host: HTMLElement; shadow: ShadowRoot } {
  const host = document.createElement("div")
  host.dataset.onceImageText = ""
  const shadow = host.attachShadow({ mode: "closed" })
  const sheet = new CSSStyleSheet()
  sheet.replaceSync(css)
  shadow.adoptedStyleSheets = [sheet]
  return { host, shadow }
}

const round = (value: number) => Math.round(value * 100) / 100

/**
 * The bar never hides text where it can help it: just below the image's
 * visible part, or above it, and only on an image filling the viewport the
 * inside corner covering the fewest words. Below or above the image's own
 * edge it is anchored like the frame (`below`, `above`), so it moves with the
 * image; at a viewport corner, or by an edge something cuts, it is `fixed`
 * in the viewport. Either way it stays put while the page scrolls.
 */
function barSpot(fit: ImageTextFit, size: { w: number; h: number }, words: Box[], anchored: boolean): BarSpot {
  const view = viewport(), box = fit.visibleBox, { w, h } = size
  const x = (left: number) => Math.max(GAP, Math.min(left, view.width - w - GAP))
  const y = (top: number) => Math.max(GAP, Math.min(top, view.height - h - GAP))
  if (!fit.visible) return { left: 0, top: 0, mode: "hidden" }
  if (box.bottom + GAP + h <= view.height - GAP) {
    return { left: x(box.right - w), top: box.bottom + GAP, mode: anchored && Math.abs(box.bottom - (fit.top + fit.height)) < 1 ? "below" : "fixed" }
  }
  if (box.top - GAP - h >= GAP) {
    return { left: x(box.right - w), top: box.top - GAP - h, mode: anchored && Math.abs(box.top - fit.top) < 1 ? "above" : "fixed" }
  }
  const picture = { left: fit.left + fit.imageLeft, top: fit.top + fit.imageTop, width: fit.imageWidth, height: fit.imageHeight }
  const covered = (left: number, top: number) => words.reduce((sum, word) => sum +
    Math.max(0, Math.min(picture.left + word.right * picture.width, left + w) - Math.max(picture.left + word.left * picture.width, left)) *
    Math.max(0, Math.min(picture.top + word.bottom * picture.height, top + h) - Math.max(picture.top + word.top * picture.height, top)), 0)
  const corner = [[box.right - w - GAP, box.bottom - h - GAP], [box.left + GAP, box.bottom - h - GAP],
    [box.right - w - GAP, box.top + GAP], [box.left + GAP, box.top + GAP]]
    .map(([left, top]) => ({ left: x(left), top: y(top) }))
    .reduce((best, spot) => covered(spot.left, spot.top) < covered(best.left, best.top) ? spot : best)
  return { ...corner, mode: "fixed" }
}

class AnchoredSelection {
  // A name of its own, not the token: the page can read its image's styles.
  private readonly anchor = `--once-image-text-${Math.random().toString(36).slice(2)}`
  private readonly previous: { value: string; priority: string }
  private readonly words = closedHost(FRAME_CSS)
  private readonly frame = document.createElement("iframe")
  private readonly bar = closedHost(OVERLAY_CSS + FRAME_CSS)
  private readonly barElement = document.createElement("div")
  private readonly status = document.createElement("span")
  private readonly source: string
  private port: MessagePort | null = null
  private readonly pending: ImageTextViewMessage[] = []
  private closed = false
  private animation = 0
  private lastFrame = ""
  private lastLayout = ""
  private lastBar = ""
  private lastBarStyle = ""
  private lastHost = ""
  private barMode: BarSpot["mode"] = "hidden"
  /** Recognized words, as fractions of the drawn picture, for keeping the bar off them. */
  private wordBoxes: Box[] = []
  private layoutMessage: Extract<ImageTextViewMessage, { type: "layout" }> | null = null
  /**
   * Where the anchor cannot hold the host to the image (an image in a top
   * layer dialog, under a transform), the host falls back to following it
   * each frame from here: in place, though no longer in the compositor's step.
   */
  private follow = false
  private misses = 0
  private followAt = { left: 0, top: 0 }
  /** The words host's z-index: the image's own, so it paints right after the image (see `mount`). */
  private readonly layer: string

  constructor(private readonly image: HTMLImageElement, readonly token: string, frameUrl: string) {
    this.source = image.currentSrc || image.src
    this.layer = getComputedStyle(image).zIndex
    this.previous = { value: image.style.getPropertyValue("anchor-name"), priority: image.style.getPropertyPriority("anchor-name") }
    const existing = getComputedStyle(image).getPropertyValue("anchor-name").trim()
    image.style.setProperty("anchor-name", existing && existing !== "none" ? `${existing}, ${this.anchor}` : this.anchor, "important")
    this.words.host.style.cssText = this.wordsStyle([...this.anchoredTo(), "left: anchor(left)", "top: anchor(top)",
      "width: anchor-size(width)", "height: anchor-size(height)"])
    this.frame.src = frameUrl
    this.frame.title = "Image text"
    this.words.shadow.append(this.frame)
    this.barElement.className = "bar"
    this.barElement.setAttribute("role", "region")
    this.barElement.setAttribute("aria-label", "Image text selection")
    this.status.setAttribute("role", "status")
    this.status.textContent = "Recognizing text…"
    const done = document.createElement("button")
    done.type = "button"
    done.textContent = "Done"
    done.onclick = () => this.close(true)
    this.barElement.append(this.status, done)
    this.bar.shadow.append(this.barElement)
    this.mount()
    document.documentElement.append(this.bar.host)
    const origin = new URL(frameUrl).origin
    this.frame.addEventListener("load", () => this.connect(origin))
    this.layout()
  }

  message(message: ImageTextViewMessage): void {
    if (this.closed) return
    if (message.type === "status") { this.status.textContent = message.text; this.lastBar = "" }
    else if (this.port) this.port.postMessage(message)
    else this.pending.push(message)
  }

  readonly close = (report: boolean): void => {
    if (this.closed) return
    this.closed = true
    cancelAnimationFrame(this.animation)
    this.port?.close()
    this.words.host.remove()
    this.bar.host.remove()
    if (this.previous.value) this.image.style.setProperty("anchor-name", this.previous.value, this.previous.priority)
    else this.image.style.removeProperty("anchor-name")
    if (current === this) current = null
    if (report) pusher()?.(JSON.stringify({ token: this.token, closed: true } satisfies ImageTextAnchorReport))
  }

  state(): ImageTextAnchorState {
    const frame = this.frame.getBoundingClientRect(), bar = this.barElement.getBoundingClientRect()
    return {
      frame: { left: frame.left, top: frame.top, width: frame.width, height: frame.height },
      clipPath: this.frame.style.clipPath, hidden: this.frame.style.visibility === "hidden",
      bar: this.barMode === "hidden" ? null : { left: bar.left, top: bar.top, right: bar.right, bottom: bar.bottom,
        text: this.status.textContent ?? "", background: getComputedStyle(this.barElement).backgroundColor, mode: this.barMode }
    }
  }

  /**
   * The words go right after the image, into the page: they paint where the
   * image paints, just above it and under whatever the page stacks over it (a
   * sticky header, a banner), and its scrollers and overflow clip them as they
   * clip the image, all in the compositor's step. Hung above the whole page,
   * they showed through such UI for the frames their clip needed to catch up.
   * A page re-rendering the image's parent may drop them; they go back.
   */
  private mount(): void {
    if (this.words.host.previousSibling !== this.image) this.image.after(this.words.host)
  }

  private wordsStyle(declarations: string[]): string {
    return hostStyle([`z-index: ${this.layer}`, ...declarations])
  }

  private anchoredTo(): string[] {
    return ["position: absolute", `position-anchor: ${this.anchor}`]
  }

  /** The frame gets a port of its own: nothing the page posts reaches it, and the page sees none of its traffic. */
  private connect(origin: string): void {
    if (this.closed || !this.frame.contentWindow) return
    const channel = new MessageChannel()
    this.port?.close()
    const port = this.port = channel.port1
    port.onmessage = (event: MessageEvent<ImageTextViewEvent>) => this.fromFrame(event.data)
    this.frame.contentWindow.postMessage({ onceImageText: this.token }, origin, [channel.port2])
    // The layout first: the words are laid out in it as they arrive.
    if (this.layoutMessage) port.postMessage(this.layoutMessage)
    this.lastLayout = this.layoutMessage ? JSON.stringify(this.layoutMessage.layout) : ""
    for (const message of this.pending.splice(0)) port.postMessage(message)
    this.frame.focus()
  }

  private fromFrame(event: ImageTextViewEvent): void {
    if (this.closed || !event || typeof event !== "object") return
    if (event.type === "close") this.close(true)
    else if (event.type === "status") { this.status.textContent = String(event.text); this.lastBar = "" }
    else if (event.type === "sweeping") this.barElement.classList.toggle("sweeping", Boolean(event.sweeping))
    else if (event.type === "words" && Array.isArray(event.boxes)) {
      this.wordBoxes = event.boxes.slice(0, 5000).map((box) => ({ left: Number(box.left) || 0, top: Number(box.top) || 0,
        right: Number(box.right) || 0, bottom: Number(box.bottom) || 0 }))
      this.lastBar = ""
    } else if (event.type === "scroll") (scrollContainer(this.image) ?? window).scrollBy(0, Number(event.deltaY) || 0)
  }

  private readonly layout = (): void => {
    if (this.closed) return
    const image = this.image
    if (!image.isConnected || (image.currentSrc || image.src) !== this.source || !image.naturalWidth) { this.close(true); return }
    const rect = image.getBoundingClientRect()
    const fit = imageFit(image, (box) => uncoveredBox(image, box, ownElement))
    this.mount()
    this.placeHost(rect)
    this.placeFrame(rect, fit)
    this.placeBar(rect, fit)
    this.animation = requestAnimationFrame(this.layout)
  }

  private placeHost(rect: DOMRect): void {
    const host = this.words.host.getBoundingClientRect()
    if (!this.follow) {
      const off = Math.abs(host.left - rect.left) > 1 || Math.abs(host.top - rect.top) > 1 ||
        Math.abs(host.width - rect.width) > 1 || Math.abs(host.height - rect.height) > 1
      this.misses = off ? this.misses + 1 : 0
      // Not on the first frames: an image still settling may move under the anchor.
      if (this.misses < 3) return
      this.follow = true
      this.lastBar = ""
      // From its containing block's corner, which the next frame measures.
      this.lastHost = this.words.host.style.cssText = this.wordsStyle(["position: absolute", "left: 0px", "top: 0px",
        `width: ${rect.width}px`, `height: ${rect.height}px`])
      return
    }
    // Moved by how far it is off, wherever its containing block is and however it is transformed.
    this.followAt = { left: this.followAt.left + rect.left - host.left, top: this.followAt.top + rect.top - host.top }
    const style = this.wordsStyle(["position: absolute", `left: ${round(this.followAt.left)}px`, `top: ${round(this.followAt.top)}px`,
      `width: ${rect.width}px`, `height: ${rect.height}px`])
    if (style !== this.lastHost) {
      this.lastHost = style
      this.words.host.style.cssText = style
    }
  }

  /**
   * The frame covers the image's content box. It is clipped where the page
   * covers the image or a scroller cuts it, but not at the viewport's own
   * edges: those clip it anyway, and a clip set here would trail a scroll.
   */
  private placeFrame(rect: DOMRect, fit: ImageTextFit): void {
    const view = viewport()
    const box = fit.visibleBox
    const bottom = fit.top + fit.height, right = fit.left + fit.width
    const inset = {
      top: box.top <= 0.5 && fit.top < 0 ? 0 : Math.max(0, box.top - fit.top),
      right: box.right >= view.width - 0.5 && right > view.width ? 0 : Math.max(0, right - box.right),
      bottom: box.bottom >= view.height - 0.5 && bottom > view.height ? 0 : Math.max(0, bottom - box.bottom),
      left: box.left <= 0.5 && fit.left < 0 ? 0 : Math.max(0, box.left - fit.left)
    }
    const onScreen = rect.bottom > 0 && rect.right > 0 && rect.top < view.height && rect.left < view.width
    const hidden = onScreen && !fit.visible
    const frameKey = [fit.left - rect.left, fit.top - rect.top, fit.width, fit.height, inset.top, inset.right, inset.bottom, inset.left]
      .map(round).join() + hidden
    if (frameKey !== this.lastFrame) {
      this.lastFrame = frameKey
      Object.assign(this.frame.style, { left: `${fit.left - rect.left}px`, top: `${fit.top - rect.top}px`,
        width: `${fit.width}px`, height: `${fit.height}px`, visibility: hidden ? "hidden" : "visible",
        clipPath: `inset(${inset.top}px ${inset.right}px ${inset.bottom}px ${inset.left}px)` })
    }
    const layout: ImageTextViewLayout = { left: fit.imageLeft, top: fit.imageTop, width: fit.imageWidth, height: fit.imageHeight,
      naturalWidth: this.image.naturalWidth, naturalHeight: this.image.naturalHeight,
      pageTop: -fit.top, pageBottom: view.height - fit.top, viewLeft: fit.left, viewTop: fit.top }
    this.layoutMessage = { type: "layout", layout }
    const layoutKey = JSON.stringify(layout)
    if (layoutKey !== this.lastLayout && this.port) {
      this.lastLayout = layoutKey
      this.port.postMessage(this.layoutMessage)
    }
  }

  private placeBar(rect: DOMRect, fit: ImageTextFit): void {
    const view = viewport()
    const { width: w, height: h } = this.barElement.getBoundingClientRect()
    const box = fit.visibleBox
    const key = [box.left, box.top, box.right, box.bottom, rect.left, rect.top, w, h, view.width, view.height, this.wordBoxes.length]
      .map(Math.round).join() + fit.visible
    if (key === this.lastBar) return
    this.lastBar = key
    const spot = barSpot(fit, { w, h }, this.wordBoxes, !this.follow)
    this.barMode = spot.mode
    const style = spot.mode === "hidden" ? hostStyle(["display: none"])
      : spot.mode === "fixed" ? hostStyle([BAR_LAYER, "position: fixed", `left: ${round(spot.left)}px`, `top: ${round(spot.top)}px`])
        // Offsets from the image's border box, which the anchor follows: unchanged while the page scrolls.
        : hostStyle([BAR_LAYER, ...this.anchoredTo(), `left: calc(anchor(left) + ${round(spot.left - rect.left)}px)`, `top: calc(anchor(top) + ${round(spot.top - rect.top)}px)`])
    if (style !== this.lastBarStyle) {
      this.lastBarStyle = style
      this.bar.host.style.cssText = style
    }
  }
}

export function installImageTextAnchor(): void {
  window.__onceImageTextAnchor ??= {
    start(token, src, x, y, frameUrl) {
      current?.close(false)
      const image = findImage(src, x, y)
      if (!image) return false
      current = new AnchoredSelection(image, token, frameUrl)
      return true
    },
    message(token, message) { if (current?.token === token) current.message(message) },
    alive(token) { return current?.token === token },
    stop(token) { if (current?.token === token) current.close(false) },
    state(token) { return current?.token === token ? current.state() : null }
  }
}
