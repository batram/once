import { BrowserWindow, WebContentsView } from "electron"
import { ElectronRect } from "@once/platform-electron/bridge"
import { ExtensionHost } from "./ExtensionHost"

const INITIAL_WIDTH = 380
const INITIAL_HEIGHT = 460
const MIN_SIZE = 80

/**
 * The browser-action popup: one `WebContentsView` laid over the window under
 * its toolbar button, sized to what the page asks for, closed when it loses
 * focus. One popup per extension at a time.
 */
export class ExtensionPopup {
  private view: WebContentsView | null = null
  private window: BrowserWindow | null = null

  constructor(private readonly host: ExtensionHost) {}

  isOpen(): boolean {
    return this.view !== null
  }

  open(window: BrowserWindow, anchor: ElectronRect): void {
    this.close()
    const url = this.host.popupUrl()
    if (!url) return
    const view = new WebContentsView({
      webPreferences: { ...this.host.webPreferences(), enablePreferredSizeMode: true }
    })
    this.view = view
    this.window = window
    this.host.register(view.webContents, "popup")
    view.setBackgroundColor("#ffffff")
    window.contentView.addChildView(view)
    this.place(anchor, INITIAL_WIDTH, INITIAL_HEIGHT)
    view.webContents.on("preferred-size-changed", (_event, size) => {
      this.place(anchor, size.width, size.height)
    })
    view.webContents.on("blur", () => this.close())
    view.webContents.on("destroyed", () => {
      if (this.view === view) this.detach()
    })
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    window.once("closed", () => this.close())
    void view.webContents.loadURL(url).then(() => view.webContents.focus())
  }

  close(): void {
    const view = this.view
    if (!view) return
    this.detach()
    // A popup that closed itself (`window.close()`, as uBlock does after
    // launching its picker) loses its webContents before the blur arrives.
    const contents = view.webContents as WebContentsView["webContents"] | undefined
    if (contents && !contents.isDestroyed()) contents.close()
  }

  private detach(): void {
    const { view, window } = this
    this.view = null
    this.window = null
    if (view && window && !window.isDestroyed()) window.contentView.removeChildView(view)
  }

  /** Under the anchor, right-aligned to it, kept inside the window. */
  private place(anchor: ElectronRect, wantedWidth: number, wantedHeight: number): void {
    const { view, window } = this
    if (!view || !window || window.isDestroyed()) return
    const content = window.getContentBounds()
    const width = Math.min(Math.max(wantedWidth, MIN_SIZE), content.width)
    const top = anchor.y + anchor.height
    const height = Math.min(Math.max(wantedHeight, MIN_SIZE), Math.max(MIN_SIZE, content.height - top))
    const x = Math.max(0, Math.min(anchor.x + anchor.width - width, content.width - width))
    view.setBounds({ x: Math.round(x), y: Math.round(top), width: Math.round(width), height: Math.round(height) })
  }
}
