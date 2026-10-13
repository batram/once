import { type ContextMenuParams, Menu, type WebContents, type WebFrameMain } from "electron"
import type { ImageTextAnchorState } from "@once/ui-web/imageText/imageTextAnchor"
import type { ImageTextResult } from "@once/ui-web/imageText/imageTextTypes"
import { type ImageTextHost, type ImageTextPicture, openImageTextHost } from "./ImageTextHost"
import { IMAGE_TEXT_SCHEME, openImageTextFrame } from "./ImageTextProtocol"

const overlays = new WeakMap<WebContents, ImageTextOverlay>()

/**
 * Image text selection, held on the image by the page's own compositor. A
 * host in an isolated world of the image's frame (ImageTextHost.ts) hangs
 * the app's words frame and bar on the image with CSS anchor positioning,
 * so they move with it in the same frame however it scrolls, through any
 * scrollers and frames, and the tab's own clipping and stacking apply.
 *
 * App-owned views laid over the tab could only follow: the page's compositor
 * shows a scroll in the frame it happens, and the views moved in the
 * window's next one at best, which showed as the selection trailing the
 * image (and spilling over the window on fast scrolls).
 *
 * The words frame is cross-origin to the page (ImageTextProtocol.ts): the
 * page cannot read the words, the selection or what is copied, nor restyle
 * them. Wheel and keys over it reach the page as over any frame.
 */
export class ImageTextOverlay {
  private closed = false
  private readonly closeHandlers: (() => void)[] = []

  private constructor(
    private readonly tab: WebContents,
    private readonly frame: WebFrameMain,
    private readonly host: ImageTextHost,
    private readonly served: ReturnType<typeof openImageTextFrame>
  ) {
    overlays.set(tab, this)
    host.onClose(this.close)
    tab.on("before-input-event", this.escape)
    tab.on("did-start-navigation", this.navigating)
    tab.on("found-in-page", this.found)
    tab.once("destroyed", this.close)
  }

  /**
   * Opens over the image the menu was opened on, in `frame`; resolves null
   * when the image is not found there, or its frame cannot be reached.
   */
  static async open(tab: WebContents, frame: WebFrameMain, src: string, x: number, y: number, token: string): Promise<ImageTextOverlay | null> {
    // One selection per tab.
    overlays.get(tab)?.close()
    const served = openImageTextFrame(token)
    const host = await openImageTextHost(tab, frame, src, x, y, token, served.url).catch((error: unknown) => {
      console.warn("Image text selection could not start", error instanceof Error ? error.message : String(error))
      return null
    })
    if (!host || tab.isDestroyed()) {
      host?.close()
      served.close()
      return null
    }
    return new ImageTextOverlay(tab, frame, host, served)
  }

  onClose(handler: () => void): void {
    if (this.closed) handler()
    else this.closeHandlers.push(handler)
  }

  /** The picture as the tab has it (see the host's `picture`). */
  picture(): Promise<ImageTextPicture | null> {
    return this.host.picture()
  }

  setImage(bytes: Buffer): void {
    this.served.setImage(bytes)
    if (!this.closed) this.host.send({ type: "image", url: this.served.imageUrl })
  }

  finish(result: ImageTextResult | null, message?: string): void {
    if (!this.closed) this.host.send({ type: "result", result, message })
  }

  readonly close = (): void => {
    if (this.closed) return
    this.closed = true
    if (overlays.get(this.tab) === this) overlays.delete(this.tab)
    this.tab.removeListener("before-input-event", this.escape)
    this.tab.removeListener("did-start-navigation", this.navigating)
    this.tab.removeListener("found-in-page", this.found)
    this.tab.removeListener("destroyed", this.close)
    this.host.close()
    this.served.close()
    for (const handler of this.closeHandlers.splice(0)) handler()
  }

  private readonly navigating = (event: Electron.Event<Electron.WebContentsDidStartNavigationEventParams>) => {
    if (!event.isSameDocument && (event.isMainFrame || event.frame === this.frame)) this.close()
  }

  /**
   * Find in page counts the words' matches like any frame's, but cannot
   * scroll to one while the image is out of view (see the host's `reveal`).
   * Chromium makes the frame of each active match the focused frame, so a
   * final result with the words frame focused is a match in them.
   * Chromium bug: https://issues.chromium.org/issues/572302955; drop this once fixed.
   */
  private readonly found = (_event: Electron.Event, result: Electron.Result) => {
    if (!result.finalUpdate || !result.activeMatchOrdinal || this.tab.isDestroyed()) return
    if (this.tab.focusedFrame?.url === this.served.url) this.host.reveal()
  }

  /** Escape closes it, from the page or the words frame alike. */
  private readonly escape = (event: Electron.Event, input: Electron.Input) => {
    if (input.type === "keyDown" && input.key === "Escape") {
      event.preventDefault()
      this.close()
    }
  }

  static state(tab: WebContents): Promise<ImageTextAnchorState | null> {
    return overlays.get(tab)?.host.state() ?? Promise.resolve(null)
  }
}

/**
 * The words frame's own menu, in place of the page's, which would offer the
 * image underneath. Returns whether the menu was the words frame's.
 */
export function showImageTextMenu(contents: WebContents, params: ContextMenuParams): boolean {
  if (!params.frame?.url.startsWith(`${IMAGE_TEXT_SCHEME}:`)) return false
  Menu.buildFromTemplate([
    { label: "Copy", enabled: Boolean(params.selectionText), click: () => { if (!contents.isDestroyed()) contents.copy() } },
    { type: "separator" },
    { label: "Done", click: () => overlays.get(contents)?.close() }
  ]).popup()
  return true
}

// The e2e tests read where the selection's parts are through the host.
if (process.env.ONCE_ELECTRON_TEST_USER_DATA) {
  (globalThis as { __onceImageTextState?: (tab: WebContents) => Promise<ImageTextAnchorState | null> }).__onceImageTextState = ImageTextOverlay.state
}
