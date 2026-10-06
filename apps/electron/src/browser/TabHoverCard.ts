import { BrowserWindow, WebContents, WebContentsView } from "electron"
import { ElectronRect, ElectronTabHoverTheme, ElectronTabState } from "@once/platform-electron/bridge"
import { isReadableUrl, sourceUrlFromReaderUrl } from "./reader-url"
import cardMarkup from "./tab-hover-card.html"
import { captureTab } from "./tabCapture"

/** The view's width; the card inside it leaves room for its shadow. */
const VIEW_WIDTH = 280
const THUMB_WIDTH = 520

interface Thumbnail {
  image: string
  aspect: string
}

export interface TabHoverSource {
  getAll(): ElectronTabState[]
  contents(id: string): WebContents
}

/**
 * The card shown while the pointer rests on a tab: its title, host and a
 * picture of the page. Tab pages are native views stacked above the shell, so
 * a card drawn in the shell's DOM would end up underneath them; it lives in a
 * view of its own, laid over the window like the extension popup.
 */
export class TabHoverCard {
  private view: WebContentsView | null = null
  private ready: Promise<unknown> = Promise.resolve()
  private request = 0
  private readonly thumbnails = new Map<string, Thumbnail>()

  constructor(private readonly window: BrowserWindow) {
    window.once("closed", () => this.dispose())
  }

  async show(
    source: TabHoverSource, id: string, anchor: ElectronRect, theme: ElectronTabHoverTheme
  ): Promise<void> {
    const request = ++this.request
    const tab = source.getAll().find((candidate) => candidate.id === id)
    if (!tab) return this.hide()
    this.forgetClosed(source)
    // The active tab is already on screen, so its card carries no picture.
    const cached = tab.active ? undefined : this.thumbnails.get(id)
    await this.render(request, tab, anchor, theme, cached)
    if (tab.active) return
    const fresh = await this.capture(source, id)
    if (!fresh) return
    this.thumbnails.set(id, fresh)
    await this.render(request, tab, anchor, theme, fresh)
  }

  hide(): void {
    this.request += 1
    const view = this.view
    if (!view || this.window.isDestroyed()) return
    if (this.window.contentView.children.includes(view)) this.window.contentView.removeChildView(view)
  }

  private async render(
    request: number, tab: ElectronTabState, anchor: ElectronRect,
    theme: ElectronTabHoverTheme, thumbnail?: Thumbnail
  ): Promise<void> {
    const view = this.ensureView()
    await this.ready
    if (request !== this.request || this.window.isDestroyed()) return
    const card = {
      title: tab.title || "New tab",
      host: hostOf(tab.url),
      theme,
      image: thumbnail?.image ?? "",
      aspect: thumbnail?.aspect ?? ""
    }
    const height = Number(await view.webContents.executeJavaScript(`render(${JSON.stringify(card)})`))
    if (request !== this.request || this.window.isDestroyed() || !Number.isFinite(height)) return
    const content = this.window.getContentBounds()
    view.setBounds({
      x: Math.round(Math.max(0, Math.min(anchor.x - 10, content.width - VIEW_WIDTH))),
      y: Math.round(anchor.y + anchor.height),
      width: VIEW_WIDTH,
      height: Math.min(height, Math.max(0, content.height - anchor.y - anchor.height))
    })
    // Adding a view it already holds moves it to the top, above the page.
    this.window.contentView.addChildView(view)
  }

  private async capture(source: TabHoverSource, id: string): Promise<Thumbnail | null> {
    try {
      const shot = await captureTab(source.contents(id), THUMB_WIDTH, 80)
      return shot && { image: `data:image/jpeg;base64,${shot.jpeg}`, aspect: `${shot.width} / ${shot.height}` }
    } catch {
      return null
    }
  }

  private ensureView(): WebContentsView {
    if (this.view) return this.view
    const view = new WebContentsView({
      webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false }
    })
    view.setBackgroundColor("#00000000")
    view.webContents.setWindowOpenHandler(() => ({ action: "deny" }))
    view.webContents.on("will-navigate", (event) => event.preventDefault())
    this.ready = view.webContents
      .loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(cardMarkup)}`)
      .catch((error) => console.error("Could not load the tab hover card", error))
    this.view = view
    return view
  }

  private forgetClosed(source: TabHoverSource): void {
    const open = new Set(source.getAll().map((tab) => tab.id))
    for (const id of this.thumbnails.keys()) if (!open.has(id)) this.thumbnails.delete(id)
  }

  private dispose(): void {
    this.request += 1
    this.thumbnails.clear()
    const contents = this.view?.webContents
    this.view = null
    if (contents && !contents.isDestroyed()) contents.close()
  }
}

/** A reader view names the site it was made from. */
function hostOf(url: string): string {
  const source = sourceUrlFromReaderUrl(url) ?? url
  if (!isReadableUrl(source)) return ""
  try {
    return new URL(source).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}
