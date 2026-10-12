import { BrowserWindow, Menu, type IpcMainEvent, type Rectangle, type WebContents, WebContentsView, type WebFrameMain } from "electron"
import type { ImageTextResult, ImageTextViewEvent, ImageTextViewMessage } from "@once/ui-web/imageText/imageTextTypes"
import type { ImageTextProbeFit } from "../imageTextProbe"
import { type ImageTextProbes, openImageTextProbes } from "./ImageTextProbes"

declare const IMAGE_TEXT_OVERLAY_WEBPACK_ENTRY: string
declare const IMAGE_TEXT_OVERLAY_PRELOAD_WEBPACK_ENTRY: string

const GAP = 8
/** The margin around the bar inside its view, for its shadow (see imageTextView.ts). */
const BAR_INSET = 6
/** Keys that move around the page, by DOM key, as sendInputEvent names them. */
const PAGE_KEYS: Record<string, string> = {
  ArrowUp: "Up", ArrowDown: "Down", ArrowLeft: "Left", ArrowRight: "Right",
  PageUp: "PageUp", PageDown: "PageDown", Home: "Home", End: "End", " ": "Space"
}
const overlays = new WeakMap<WebContents, ImageTextOverlay>()

/**
 * Image text selection in app-owned views over a tab: nothing of the overlay
 * enters the page. Read-only probes (ImageTextProbes.ts) report where the
 * image is drawn and which part of it is visible, through any frames holding
 * it; the words view covers exactly that part and the bar view sits beside
 * it. Both follow the image until the selection closes.
 */
export class ImageTextOverlay {
  private readonly words = createView()
  private readonly bar = createView()
  private readonly ready: Promise<unknown>
  private barSize = { width: 0, height: 0 }
  /** Recognized words, as fractions of the drawn picture, for keeping the bar off them. */
  private wordBoxes: { left: number; top: number; right: number; bottom: number }[] = []
  private lastWords = ""
  private lastBar = ""
  private shown = false
  private closed = false
  private watchdog: ReturnType<typeof setInterval> | undefined
  private readonly closeHandlers: (() => void)[] = []

  private constructor(
    private readonly window: BrowserWindow,
    private readonly tabView: WebContentsView,
    private readonly tab: WebContents,
    private readonly frame: WebFrameMain,
    private readonly probes: ImageTextProbes,
    private fit: ImageTextProbeFit
  ) {
    this.words.webContents.on("before-input-event", this.forwardKey)
    this.words.webContents.ipc.on("image-text-overlay:event", this.event)
    this.bar.webContents.ipc.on("image-text-overlay:event", this.event)
    // The words view's own menu: the page's would offer the image underneath.
    this.words.webContents.on("context-menu", (_event, params) => {
      Menu.buildFromTemplate([
        { label: "Copy", enabled: Boolean(params.selectionText), click: () => this.words.webContents.copy() },
        { type: "separator" },
        { label: "Done", click: this.close }
      ]).popup()
    })
    this.ready = Promise.all([load(this.words, ""), load(this.bar, "#bar")])
    overlays.set(tab, this)
    tab.on("before-input-event", this.escape)
    tab.on("did-start-navigation", this.navigating)
    tab.once("destroyed", this.close)
    window.once("closed", this.close)
    probes.onChange((fit) => {
      if (this.closed) return
      if (!fit) this.close()
      else this.apply(fit)
    })
    void this.ready.then(() => {
      if (this.closed) return
      this.apply(this.fit)
      this.words.webContents.focus()
      // The page reports its own changes; the tab moving, zooming or hiding does not change the page.
      this.watchdog = setInterval(() => {
        if (this.tab.isDestroyed() || this.window.isDestroyed() || !this.window.contentView.children.includes(this.tabView)) this.close()
        else this.apply(this.fit)
      }, 100)
    })
  }

  /**
   * Opens over the image the menu was opened on, in `frame`; resolves null
   * when the image is not found there, or its frame cannot be probed.
   */
  static async open(tab: WebContents, frame: WebFrameMain, src: string, x: number, y: number, token: string): Promise<ImageTextOverlay | null> {
    const owner = viewOf(tab)
    if (!owner) return null
    // One selection per tab: the previous one lets go of the tab's probes first.
    overlays.get(tab)?.close()
    const opened = await openImageTextProbes(tab, frame, src, x, y, token)
    if (!opened) return null
    if (tab.isDestroyed() || owner.window.isDestroyed()) { opened.probes.close(); return null }
    return new ImageTextOverlay(owner.window, owner.view, tab, frame, opened.probes, opened.fit)
  }

  onClose(handler: () => void): void {
    if (this.closed) handler()
    else this.closeHandlers.push(handler)
  }

  setImage(bytes: Buffer): void {
    void this.send(this.words, { type: "image", bytes: new Uint8Array(bytes) })
  }

  finish(result: ImageTextResult | null, message?: string): void {
    void this.send(this.words, { type: "result", result, message })
  }

  readonly close = (): void => {
    if (this.closed) return
    this.closed = true
    if (overlays.get(this.tab) === this) overlays.delete(this.tab)
    this.tab.removeListener("before-input-event", this.escape)
    this.tab.removeListener("did-start-navigation", this.navigating)
    this.tab.removeListener("destroyed", this.close)
    this.window.removeListener("closed", this.close)
    const focused = this.words.webContents.isFocused() || this.bar.webContents.isFocused()
    for (const view of [this.words, this.bar]) {
      if (!this.window.isDestroyed() && this.window.contentView.children.includes(view)) this.window.contentView.removeChildView(view)
      if (!view.webContents.isDestroyed()) view.webContents.close()
    }
    clearInterval(this.watchdog)
    this.probes.close()
    if (!this.tab.isDestroyed() && focused) this.tab.focus()
    for (const handler of this.closeHandlers.splice(0)) handler()
  }

  /** Lays the views over the image, in window pixels: page CSS pixels times the tab's zoom. */
  private apply(fit: ImageTextProbeFit): void {
    this.fit = fit
    const zoom = this.tab.getZoomFactor()
    const tab = this.tabView.getBounds()
    const box = fit.visibleBox
    const visible = fit.visible && box.right > box.left && box.bottom > box.top
    if (!visible) {
      this.show(false)
      return
    }
    const left = Math.floor(tab.x + box.left * zoom), top = Math.floor(tab.y + box.top * zoom)
    const words: Rectangle = { x: left, y: top,
      width: Math.max(1, Math.ceil(tab.x + box.right * zoom) - left), height: Math.max(1, Math.ceil(tab.y + box.bottom * zoom) - top) }
    const layout = {
      left: tab.x + (fit.left + fit.imageLeft) * zoom - left,
      top: tab.y + (fit.top + fit.imageTop) * zoom - top,
      width: fit.imageWidth * zoom, height: fit.imageHeight * zoom,
      naturalWidth: fit.naturalWidth, naturalHeight: fit.naturalHeight,
      pageTop: tab.y - top, pageBottom: tab.y + fit.viewportHeight * zoom - top,
      viewLeft: left - tab.x, viewTop: top - tab.y
    }
    const key = JSON.stringify([words, layout])
    if (key !== this.lastWords) {
      this.lastWords = key
      this.words.setBounds(words)
      void this.send(this.words, { type: "layout", layout })
    }
    const picture = { x: left + layout.left, y: top + layout.top, width: layout.width, height: layout.height }
    this.placeBar(words, picture, { x: tab.x, y: tab.y, width: fit.viewportWidth * zoom, height: fit.viewportHeight * zoom })
    this.show(true)
  }

  /**
   * The bar never hides text where it can help it: it sits just below the
   * image's visible part, or above it, and only on an image filling the page
   * takes the inside corner covering the fewest recognized words. It stays
   * inside the page's viewport, clear of its scrollbars.
   */
  private placeBar(image: Rectangle, picture: Rectangle, page: Rectangle): void {
    const { width, height } = this.barSize
    if (!width || !height) return
    // The view holds the bar and its shadow; place the bar itself.
    const w = width - BAR_INSET * 2, h = height - BAR_INSET * 2
    const x = (left: number) => Math.max(page.x + GAP, Math.min(left, page.x + page.width - w - GAP))
    const y = (top: number) => Math.max(page.y + GAP, Math.min(top, page.y + page.height - h - GAP))
    const below = image.y + image.height + GAP
    const above = image.y - GAP - h
    let place = below + h <= page.y + page.height - GAP ? { left: x(image.x + image.width - w), top: below }
      : above >= page.y + GAP ? { left: x(image.x + image.width - w), top: above } : null
    if (!place) {
      const words = this.wordBoxes.map((box) => ({ left: picture.x + box.left * picture.width, top: picture.y + box.top * picture.height,
        right: picture.x + box.right * picture.width, bottom: picture.y + box.bottom * picture.height }))
      const covered = (spot: { left: number; top: number }) => words.reduce((sum, word) =>
        sum + Math.max(0, Math.min(word.right, spot.left + w) - Math.max(word.left, spot.left)) *
          Math.max(0, Math.min(word.bottom, spot.top + h) - Math.max(word.top, spot.top)), 0)
      const right = image.x + image.width - w - GAP, left = image.x + GAP
      const bottom = image.y + image.height - h - GAP, top = image.y + GAP
      place = [[right, bottom], [left, bottom], [right, top], [left, top]]
        .map(([spotLeft, spotTop]) => ({ left: x(spotLeft), top: y(spotTop) }))
        .reduce((best, spot) => covered(spot) < covered(best) ? spot : best)
    }
    const bounds = { x: Math.round(place.left - BAR_INSET), y: Math.round(place.top - BAR_INSET), width, height }
    const key = JSON.stringify(bounds)
    if (key !== this.lastBar) {
      this.lastBar = key
      this.bar.setBounds(bounds)
    }
  }

  private show(visible: boolean): void {
    if (visible === this.shown || this.window.isDestroyed()) return
    this.shown = visible
    const children = this.window.contentView.children
    for (const view of [this.words, this.bar]) {
      // Adding a view it already holds moves it to the top, above the page.
      if (visible) this.window.contentView.addChildView(view)
      else if (children.includes(view)) this.window.contentView.removeChildView(view)
    }
  }

  private readonly event = (event: IpcMainEvent, message: ImageTextViewEvent) => {
    if (this.closed || !message || typeof message !== "object") return
    const fromWords = event.sender === this.words.webContents
    if (message.type === "close") this.close()
    else if (message.type === "status" && fromWords) void this.send(this.bar, { type: "status", text: String(message.text) })
    else if (message.type === "sweeping" && fromWords) void this.send(this.bar, { type: "sweeping", sweeping: Boolean(message.sweeping) })
    else if (message.type === "size" && !fromWords) {
      this.barSize = { width: Math.ceil(Number(message.width)) || 0, height: Math.ceil(Number(message.height)) || 0 }
      this.lastBar = ""
      this.apply(this.fit)
    } else if (message.type === "wheel" && fromWords) this.wheel(message)
    else if (message.type === "words" && fromWords && Array.isArray(message.boxes)) {
      this.wordBoxes = message.boxes.slice(0, 5000).map((box) => ({ left: Number(box.left) || 0, top: Number(box.top) || 0,
        right: Number(box.right) || 0, bottom: Number(box.bottom) || 0 }))
      this.lastBar = ""
      this.apply(this.fit)
    } else if (message.type === "scroll" && fromWords) this.scroll(Number(message.deltaY) || 0)
  }

  /** A sweep held at the page's edge scrolls whatever scrolls the image, as a wheel over it would. */
  private scroll(deltaY: number): void {
    const view = this.words.getBounds()
    this.wheel({ type: "wheel", x: view.width / 2, y: view.height / 2, deltaX: 0, deltaY })
  }

  /** The words view covers the image, so wheel scrolling over it goes back to the page underneath. */
  private wheel(message: Extract<ImageTextViewEvent, { type: "wheel" }>): void {
    if (this.tab.isDestroyed()) return
    const view = this.words.getBounds(), tab = this.tabView.getBounds()
    this.tab.sendInputEvent({
      type: "mouseWheel", x: Math.round(view.x - tab.x + Number(message.x)), y: Math.round(view.y - tab.y + Number(message.y)),
      deltaX: -Number(message.deltaX) || 0, deltaY: -Number(message.deltaY) || 0, hasPreciseScrollingDeltas: true, canScroll: true
    })
  }

  private readonly navigating = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (!event.isSameDocument && (event.isMainFrame || event.frame === this.frame)) this.close()
  }

  /**
   * The overlay holds the keyboard while it is open, for copying and select
   * all; keys that move around the page still go to the page.
   */
  private readonly forwardKey = (event: Electron.Event, input: Electron.Input) => {
    const keyCode = PAGE_KEYS[input.key]
    if (!keyCode || input.control || input.meta || input.alt || this.tab.isDestroyed()) return
    if (input.type !== "keyDown" && input.type !== "keyUp") return
    event.preventDefault()
    const modifiers = input.shift ? ["shift" as const] : []
    this.tab.sendInputEvent({ type: input.type, keyCode, modifiers })
    // Space scrolls on the character it types, not on the key press.
    if (input.type === "keyDown" && keyCode === "Space") this.tab.sendInputEvent({ type: "char", keyCode: " ", modifiers })
  }

  private readonly escape = (event: Electron.Event, input: Electron.Input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault()
      this.close()
    }
  }

  private async send(view: WebContentsView, message: ImageTextViewMessage): Promise<void> {
    await this.ready
    if (!this.closed && !view.webContents.isDestroyed()) view.webContents.send("image-text-overlay:message", message)
  }
}

function createView(): WebContentsView {
  const view = new WebContentsView({
    webPreferences: { preload: IMAGE_TEXT_OVERLAY_PRELOAD_WEBPACK_ENTRY, sandbox: true, contextIsolation: true, nodeIntegration: false }
  })
  view.setBackgroundColor("#00000000")
  view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
  view.webContents.on("will-navigate", (event) => event.preventDefault())
  return view
}

function load(view: WebContentsView, hash: string): Promise<void> {
  return view.webContents.loadURL(`${IMAGE_TEXT_OVERLAY_WEBPACK_ENTRY}${hash}`)
}

/** The window and view showing a tab. */
function viewOf(tab: WebContents): { window: BrowserWindow; view: WebContentsView } | null {
  for (const window of BrowserWindow.getAllWindows()) {
    const view = window.contentView.children.find((child): child is WebContentsView =>
      child instanceof WebContentsView && child.webContents === tab)
    if (view) return { window, view }
  }
  return null
}
