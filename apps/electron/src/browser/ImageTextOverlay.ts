import { BrowserWindow, Menu, type IpcMainEvent, type Rectangle, type WebContents, WebContentsView } from "electron"
import { readFileSync } from "node:fs"
import path from "node:path"
import type { ImageTextResult, ImageTextViewEvent, ImageTextViewMessage } from "@once/ui-web/imageText/imageTextTypes"
import type { ImageTextProbeFit } from "../imageTextProbe"

declare const IMAGE_TEXT_OVERLAY_WEBPACK_ENTRY: string
declare const IMAGE_TEXT_OVERLAY_PRELOAD_WEBPACK_ENTRY: string

/** The isolated world the probe runs in; extension content scripts start at 1000. */
const PROBE_WORLD = 917
const GAP = 8
/** The margin around the bar inside its view, for its shadow (see imageTextView.ts). */
const BAR_INSET = 6
let probeSource: string | undefined
const overlays = new WeakMap<WebContents, ImageTextOverlay>()

/**
 * Image text selection in app-owned views over a tab: nothing of the overlay
 * enters the page. A read-only probe in an isolated world of the tab's main
 * frame reports where the image is drawn and which part of it is visible; the
 * words view covers exactly that part and the bar view sits beside it. Both
 * follow the image every frame until the selection closes.
 */
export class ImageTextOverlay {
  private readonly words = createView()
  private readonly bar = createView()
  private readonly ready: Promise<unknown>
  private barSize = { width: 0, height: 0 }
  private lastWords = ""
  private lastBar = ""
  private shown = false
  private closed = false
  private readonly closeHandlers: (() => void)[] = []

  private constructor(
    private readonly window: BrowserWindow,
    private readonly tabView: WebContentsView,
    private readonly tab: WebContents,
    private readonly token: string,
    private fit: ImageTextProbeFit
  ) {
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
    overlays.get(tab)?.close()
    overlays.set(tab, this)
    tab.on("before-input-event", this.escape)
    tab.on("did-start-navigation", this.navigating)
    tab.once("destroyed", this.close)
    window.once("closed", this.close)
    void this.ready.then(() => {
      if (this.closed) return
      this.apply(this.fit)
      this.words.webContents.focus()
      void this.track()
    })
  }

  /** Opens over the image the menu was opened on, or resolves null when the tab's main frame has no such image. */
  static async open(tab: WebContents, src: string, x: number, y: number, token: string): Promise<ImageTextOverlay | null> {
    const owner = viewOf(tab)
    if (!owner) return null
    probeSource ??= readFileSync(path.join(__dirname, "image-text-probe.js"), "utf8")
    await tab.executeJavaScriptInIsolatedWorld(PROBE_WORLD, [{ code: probeSource }])
    const fit = await probe<ImageTextProbeFit | null>(tab,
      `window.__onceImageTextProbe.start(${JSON.stringify(src)}, ${Number(x)}, ${Number(y)}, ${JSON.stringify(token)})`)
    return fit ? new ImageTextOverlay(owner.window, owner.view, tab, token, fit) : null
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
    if (!this.tab.isDestroyed()) {
      void probe(this.tab, `window.__onceImageTextProbe?.stop(${JSON.stringify(this.token)})`).catch(() => undefined)
      if (focused) this.tab.focus()
    }
    for (const handler of this.closeHandlers.splice(0)) handler()
  }

  /** Follows the image each frame; the selection closes once it is gone or its tab is hidden. */
  private async track(): Promise<void> {
    while (!this.closed) {
      await new Promise((resolve) => setTimeout(resolve, 16))
      if (this.closed) return
      if (this.tab.isDestroyed() || this.window.isDestroyed() || !this.window.contentView.children.includes(this.tabView)) {
        this.close()
        return
      }
      const fit = await probe<ImageTextProbeFit | null>(this.tab,
        `window.__onceImageTextProbe?.measure(${JSON.stringify(this.token)}) ?? null`).catch(() => null)
      if (this.closed) return
      if (!fit) { this.close(); return }
      this.apply(fit)
    }
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
      naturalWidth: fit.naturalWidth, naturalHeight: fit.naturalHeight
    }
    const key = JSON.stringify([words, layout])
    if (key !== this.lastWords) {
      this.lastWords = key
      this.words.setBounds(words)
      void this.send(this.words, { type: "layout", layout })
    }
    this.placeBar(words, { x: tab.x, y: tab.y, width: fit.viewportWidth * zoom, height: fit.viewportHeight * zoom })
    this.show(true)
  }

  /**
   * Below the image's visible part, else above it, else in its bottom corner;
   * kept inside the page's viewport, clear of its scrollbars.
   */
  private placeBar(image: Rectangle, page: Rectangle): void {
    const { width, height } = this.barSize
    if (!width || !height) return
    // The view holds the bar and its shadow; place the bar itself.
    const w = width - BAR_INSET * 2, h = height - BAR_INSET * 2
    const x = Math.max(page.x + GAP, Math.min(image.x + image.width - w, page.x + page.width - w - GAP))
    const below = image.y + image.height + GAP
    const above = image.y - GAP - h
    const y = below + h <= page.y + page.height - GAP ? below
      : above >= page.y + GAP ? above
        : Math.max(page.y + GAP, image.y + image.height - h - GAP)
    const bounds = { x: Math.round(x - BAR_INSET), y: Math.round(y - BAR_INSET), width, height }
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
    if (event.isMainFrame && !event.isSameDocument) this.close()
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

function probe<T>(tab: WebContents, code: string): Promise<T> {
  return tab.executeJavaScriptInIsolatedWorld(PROBE_WORLD, [{ code }]) as Promise<T>
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
