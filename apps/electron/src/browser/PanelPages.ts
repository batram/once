import { ipcMain, WebContentsView } from "electron"
import { ELECTRON_IPC, ElectronRect } from "@once/platform-electron/bridge"
import { BROWSER_SESSION_PARTITION, BrowserCoordinator } from "../TabManager"
import { WindowEntry } from "./BrowserState"
import { adoptPanelPage } from "./ExtensionTabHooks"
import { createTabView } from "./TabView"

function webUrl(value: unknown): string {
  const url = new URL(String(value))
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("Only HTTP and HTTPS pages can open in the panel")
  return url.toString()
}

function readRect(value: ElectronRect | null | undefined): ElectronRect | null {
  if (!value) return null
  const { x, y, width, height } = value
  if (![x, y, width, height].every(Number.isFinite)) throw new Error("Invalid panel page bounds")
  return { x, y, width, height }
}

/**
 * A web page inside the shell's panel rather than in a tab: a story's comments
 * beside the page the reader is on. A view in the browser session, so the
 * reader is logged in and extensions apply as they do in a tab, laid over the
 * rect the panel keeps empty for it and hidden while that rect is.
 *
 * Following a link to another site opens it in a tab, which is where pages
 * are read; the panel keeps its comments.
 */
class PanelPage {
  readonly view: WebContentsView
  private done = false
  private readonly onWindowClosed = (): void => this.close()
  private readonly onShellNavigated = (): void => this.close()

  constructor(
    private readonly owner: WindowEntry,
    private readonly coordinator: BrowserCoordinator,
    private readonly closed: () => void
  ) {
    this.view = createTabView("about:blank", null, BROWSER_SESSION_PARTITION)
    this.view.setBackgroundColor("#ffffff")
    this.view.setVisible(false)
    owner.window.contentView.addChildView(this.view)
    const contents = this.view.webContents
    adoptPanelPage(owner, contents, coordinator.tabCreated)
    contents.setWindowOpenHandler(({ url, disposition }) => {
      if (/^https?:/i.test(url)) void coordinator.createTab(owner, url, disposition !== "background-tab")
      return { action: "deny" }
    })
    contents.on("will-navigate", (event, url) => {
      if (this.sameSite(url)) return
      event.preventDefault()
      if (/^https?:/i.test(url)) void coordinator.createTab(owner, url, true)
    })
    contents.on("context-menu", (_event, params) => coordinator.menus.showContentsMenu(owner, contents, params))
    contents.on("did-navigate", (_event, url) => this.report(url))
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => { if (isMainFrame) this.report(url) })
    contents.on("render-process-gone", () => this.close())
    owner.window.once("closed", this.onWindowClosed)
    // A reloaded shell forgets its panel; the page must not linger over it.
    owner.window.webContents.once("did-navigate", this.onShellNavigated)
  }

  load(url: string): void {
    void this.view.webContents.loadURL(url).catch((error: unknown) => {
      // An aborted load (another page asked for meanwhile) is not a failure.
      if ((error as { code?: string })?.code !== "ERR_ABORTED") console.error("Could not load the panel page", error)
    })
  }

  setBounds(rect: ElectronRect | null): void {
    const content = this.owner.window.getContentBounds()
    const x = Math.max(0, Math.round(rect?.x ?? 0))
    const y = Math.max(0, Math.round(rect?.y ?? 0))
    const width = Math.max(0, Math.min(Math.round(rect?.width ?? 0), content.width - x))
    const height = Math.max(0, Math.min(Math.round(rect?.height ?? 0), content.height - y))
    const visible = width > 0 && height > 0
    if (visible) this.view.setBounds({ x, y, width, height })
    this.view.setVisible(visible)
  }

  /**
   * `report` tells the shell the page is gone. Not when the shell asked: a
   * late report would reach the panel it opened next and close that instead.
   */
  close(report = true): void {
    if (this.done) return
    this.done = true
    const { window } = this.owner
    window.off("closed", this.onWindowClosed)
    if (!window.isDestroyed()) {
      window.webContents.off("did-navigate", this.onShellNavigated)
      window.contentView.removeChildView(this.view)
      if (report) this.send(null)
    }
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
    this.closed()
  }

  /** The same site as the page shown, which a link may keep in the panel. */
  private sameSite(url: string): boolean {
    try {
      return new URL(url).origin === new URL(this.view.webContents.getURL()).origin
    } catch {
      return false
    }
  }

  private report(url: string): void {
    if (/^https?:/i.test(url)) this.send(url)
  }

  private send(url: string | null): void {
    const shell = this.owner.window.webContents
    if (!shell.isDestroyed()) shell.send(ELECTRON_IPC.panelPageChanged, url)
  }
}

/** One panel page per window, opened, placed and closed by its shell. */
export function registerPanelPageHandlers(coordinator: BrowserCoordinator): void {
  const pages = new Map<number, PanelPage>()
  ipcMain.handle(ELECTRON_IPC.panelPageShow, (event, url: string, bounds: ElectronRect | null) => {
    const owner = coordinator.requireWindow(event)
    const target = webUrl(url)
    const rect = readRect(bounds)
    let page = pages.get(owner.id)
    if (!page) {
      page = new PanelPage(owner, coordinator, () => pages.delete(owner.id))
      pages.set(owner.id, page)
    }
    page.setBounds(rect)
    page.load(target)
  })
  ipcMain.handle(ELECTRON_IPC.panelPageSetBounds, (event, bounds: ElectronRect | null) => {
    const owner = coordinator.requireWindow(event)
    pages.get(owner.id)?.setBounds(readRect(bounds))
  })
  ipcMain.handle(ELECTRON_IPC.panelPageClose, (event) => {
    const owner = coordinator.requireWindow(event)
    pages.get(owner.id)?.close(false)
  })
}
