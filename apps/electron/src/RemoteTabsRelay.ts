import { CustomScheme, ipcMain, IpcMainEvent, IpcMainInvokeEvent, net, Session, WebContents, webContents } from "electron"
import { ELECTRON_IPC, REMOTE_TABS_URL } from "@once/platform-electron/bridge"
import type { BrowserCoordinator } from "./TabManager"
import type { WindowEntry } from "./browser/BrowserState"

const SERVED = new Set(["index.html", "index.js", "index.js.map"])

export function isRemoteTabsUrl(url: string): boolean {
  return url.startsWith("once-tabs://view/")
}

/** For the app's one `registerSchemesAsPrivileged` call. */
export function remoteTabsScheme(): CustomScheme {
  return { scheme: "once-tabs", privileges: { standard: true, secure: true } }
}

function notFound(): Response {
  return new Response("Not part of the tabs page", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } })
}

/**
 * The tabs page for the browser session's tabs: the Forge `remote_tabs`
 * entry plus the shell's stylesheet and icon folders, as `css/…` and `imgs/…`.
 */
export function configureRemoteTabsProtocol(targetSession: Session, shellEntryUrl: string): void {
  targetSession.protocol.handle("once-tabs", (request) => {
    const url = new URL(request.url)
    if (url.host !== "view") return notFound()
    const parts = url.pathname.split("/").filter(Boolean)
    // The shell's stylesheets, and the icons they draw from.
    if ((parts[0] === "css" || parts[0] === "imgs") && parts.length > 1 && parts.every((part) => /^[\w.-]+$/.test(part) && part !== "..")) {
      return net.fetch(new URL(`../main_window/${parts.join("/")}`, shellEntryUrl).toString())
    }
    const name = parts.pop() ?? ""
    if (!SERVED.has(name)) return notFound()
    return net.fetch(new URL(`../remote_tabs/${name}`, shellEntryUrl).toString())
  })
}

interface Attachment { shell: WebContents; release(): void }

/**
 * Passes the window shell's view of other devices' tabs to a tabs page shown
 * in one of its tabs, and the reader's choices back. Main never reads either;
 * it keeps each page to its own window's shell and ends the attachment when
 * the page goes away, navigates elsewhere, or the shell closes.
 */
export class RemoteTabsRelay {
  private readonly attachments = new Map<number, Attachment>()

  constructor(private readonly coordinator: BrowserCoordinator) {}

  register(): void {
    ipcMain.handle(ELECTRON_IPC.remoteTabsOpen, (event) => this.open(this.coordinator.requireWindow(event)))
    ipcMain.on(ELECTRON_IPC.remoteTabsPush, (event, tabId: number, state: unknown) => {
      const shell = this.coordinator.requireWindow(event as unknown as IpcMainInvokeEvent).window.webContents
      const attachment = this.attachments.get(Number(tabId))
      const tab = attachment ? webContents.fromId(Number(tabId)) : undefined
      if (attachment?.shell === shell && tab && !tab.isDestroyed() && isRemoteTabsUrl(tab.getURL())) {
        tab.send(ELECTRON_IPC.remoteTabsState, state)
      }
    })
    ipcMain.handle(ELECTRON_IPC.remoteTabsConnect, (event) => this.connect(this.page(event)))
    ipcMain.on(ELECTRON_IPC.remoteTabsCommand, (event, command: unknown) => {
      const tab = this.page(event)
      const attachment = this.attachments.get(tab.id)
      if (attachment && !attachment.shell.isDestroyed()) attachment.shell.send(ELECTRON_IPC.remoteTabsCommand, tab.id, command)
    })
  }

  /** Focuses this window's tabs page, or opens one. */
  async open(owner: WindowEntry): Promise<void> {
    const existing = this.coordinator.getAll(owner).find((tab) => isRemoteTabsUrl(tab.url))
    if (existing) this.coordinator.activate(owner, existing.id)
    else await this.coordinator.createTab(owner, REMOTE_TABS_URL, true)
  }

  private connect(tab: WebContents): void {
    this.detach(tab.id)
    const shell = this.coordinator.shellOf(tab)
    if (!shell || shell.isDestroyed()) return
    const left = () => { if (this.attachments.get(tab.id) === attachment) this.detach(tab.id) }
    const attachment: Attachment = {
      shell,
      release: () => {
        tab.removeListener("destroyed", left)
        tab.removeListener("did-navigate", left)
        shell.removeListener("destroyed", left)
      }
    }
    this.attachments.set(tab.id, attachment)
    tab.once("destroyed", left)
    tab.on("did-navigate", left)
    shell.once("destroyed", left)
    shell.send(ELECTRON_IPC.remoteTabsAttach, tab.id)
  }

  private detach(tabId: number): void {
    const attachment = this.attachments.get(tabId)
    if (!attachment) return
    this.attachments.delete(tabId)
    attachment.release()
    if (!attachment.shell.isDestroyed()) attachment.shell.send(ELECTRON_IPC.remoteTabsDetach, tabId)
  }

  /** Only the tabs page's own top frame may speak for it. */
  private page(event: IpcMainEvent | IpcMainInvokeEvent): WebContents {
    if (!isRemoteTabsUrl(event.sender.getURL()) || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Untrusted tabs page sender")
    }
    return event.sender
  }
}
