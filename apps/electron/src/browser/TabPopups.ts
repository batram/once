import { Menu } from "electron"
import { ElectronPoint } from "@once/platform-electron/bridge"
import { TabEntry, WindowEntry } from "./BrowserState"
import { PopupWindowOptions } from "./TabView"

interface PopupActions {
  ownerFor(entry: TabEntry): WindowEntry | undefined
  notify(entry: TabEntry): void
  normalizeUrl(url: string): string
  createPopup(owner: WindowEntry, url: string, disposition: string,
    options: PopupWindowOptions): Electron.WebContents
}

// Chromium's transient activation lasts five seconds and is spent by a popup.
// Electron doesn't expose it in HandlerDetails. Observe native input in main,
// never page-dispatched DOM events or a renderer's claim to have been clicked.
const ACTIVATION_MS = 5000
const MAX_BLOCKED = 20

export class TabPopups {
  private readonly activation = new WeakMap<TabEntry, number>()

  constructor(private readonly actions: PopupActions, private readonly now = () => performance.now()) {}

  bind(entry: TabEntry): void {
    const contents = entry.view.webContents
    contents.on("before-mouse-event", (event, mouse) => {
      if (!event.defaultPrevented && mouse.type === "mouseDown") this.activate(entry)
    })
    contents.on("did-start-navigation", (event) => {
      if (!event.isMainFrame || event.isSameDocument) return
      this.activation.delete(entry)
      if (entry.blockedPopups?.length) {
        entry.blockedPopups = []
        this.actions.notify(entry)
      }
    })
    contents.setWindowOpenHandler((request) => this.open(entry, request))
  }

  keyDown(entry: TabEntry, event: Electron.Event, input: Electron.Input): void {
    if (event.defaultPrevented || input.type !== "keyDown" || input.isAutoRepeat) return
    if (["Escape", "Shift", "Control", "Alt", "Meta", "CapsLock"].includes(input.key)) return
    this.activate(entry)
  }

  private activate(entry: TabEntry): void {
    this.activation.set(entry, this.now() + ACTIVATION_MS)
  }

  private open(entry: TabEntry, request: Electron.HandlerDetails): Electron.WindowOpenHandlerResponse {
    const owner = this.actions.ownerFor(entry)
    if (!owner || owner.closing || owner.window.isDestroyed()) return { action: "deny" }
    let url: string
    try { url = this.actions.normalizeUrl(request.url) }
    catch { return { action: "deny" } }
    const expires = this.activation.get(entry) ?? -Infinity
    this.activation.delete(entry)
    if (this.now() >= expires) {
      const blocked = entry.blockedPopups ??= []
      if (blocked.length < MAX_BLOCKED) {
        blocked.push({ ...request, url })
        this.actions.notify(entry)
      }
      return { action: "deny" }
    }
    // Returning a real WindowProxy avoids the page's popup-blocked fallback.
    return {
      action: "allow",
      outlivesOpener: true,
      createWindow: (options: PopupWindowOptions) => {
        const contents = this.actions.createPopup(owner, url, request.disposition, options)
        // Electron navigates the pending contents it made for window.open. A
        // link opened in a new tab (middle click, Ctrl+click) has none, so
        // that navigation is ours; without it the tab would stay blank.
        if (!options.webContents) this.load(contents, url, request)
        return contents
      }
    }
  }

  showBlocked(entry: TabEntry, point: ElectronPoint): void {
    const owner = this.actions.ownerFor(entry)
    const blocked = entry.blockedPopups ?? []
    if (!owner || !blocked.length) return
    Menu.buildFromTemplate([
      ...blocked.map(request => ({
        label: `Open ${request.url.replace(/&/g, "&&")}`,
        click: () => this.openBlocked(entry, request)
      })),
      { type: "separator" },
      { label: "Dismiss blocked popups", click: () => {
        entry.blockedPopups = []
        this.actions.notify(entry)
      } }
    ]).popup({ window: owner.window, x: Math.round(point.x), y: Math.round(point.y) })
  }

  private openBlocked(entry: TabEntry, request: Electron.HandlerDetails): void {
    const owner = this.actions.ownerFor(entry)
    // A menu can outlive its tab, its document, or a transfer to another window.
    if (!owner || owner.closing || entry.view.webContents.isDestroyed() ||
      !entry.blockedPopups?.includes(request)) return
    const url = this.actions.normalizeUrl(request.url)
    entry.blockedPopups = entry.blockedPopups.filter(candidate => candidate !== request)
    this.actions.notify(entry)
    this.load(this.actions.createPopup(owner, url, request.disposition, {}), url, request)
  }

  /** Reproduces what Electron's own popup navigation carries: referrer and body. */
  private load(contents: Electron.WebContents, url: string, request: Electron.HandlerDetails): void {
    const body = request.postBody
    void contents.loadURL(url, {
      httpReferrer: request.referrer,
      ...(body ? {
        postData: body.data,
        extraHeaders: `Content-Type: ${body.contentType}${body.boundary ? `; boundary=${body.boundary}` : ""}`
      } : {})
    }).catch(error => {
      // Navigation events display real load failures in the new tab.
      if (error.code !== "ERR_ABORTED") console.warn("Popup could not load", error)
    })
  }
}
