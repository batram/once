import {
  clipboard,
  ContextMenuParams,
  Menu,
  MenuItemConstructorOptions,
  shell,
  WebContents
} from "electron"
import { ELECTRON_IPC, ElectronPoint } from "@once/platform-electron/bridge"
import { ElectronStoryMenuItem } from "@once/platform-electron/bridge"
import { WindowEntry } from "./BrowserState"
import { PageActions } from "./PageActions"
import { sourceUrlFromReaderUrl } from "./reader-url"

interface NativeMenuActions {
  close(owner: WindowEntry, id: string): void
  createTab(owner: WindowEntry, url: string, active: boolean): Promise<string>
  createWindow(url: string): Promise<void>
  detach(owner: WindowEntry, id: string): Promise<void>
  duplicate(owner: WindowEntry, id: string): Promise<string>
  normalizeUrl(url: string): string | null
  toggleMuted(owner: WindowEntry, id: string): void
}

const isWebUrl = (url: unknown): url is string => typeof url === "string" && (url.startsWith("http://") || url.startsWith("https://"))

export class NativeMenus {
  /** The add-on actions each window's renderer offers for pages; the page menu lists them. */
  readonly pageActions = new PageActions()
  /** The devices a tab can be sent to, as the renderer last reported them. */
  sendTargets: Array<{ deviceId: string; name: string }> = []

  constructor(private readonly actions: NativeMenuActions) {}

  showTabMenu(
    owner: WindowEntry,
    id: string,
    point: ElectronPoint,
    hasPlayedAudio: boolean,
    muted: boolean
  ): void {
    const template: MenuItemConstructorOptions[] = [
      {
        label: "Inspect",
        click: () => this.inspect(owner.window.webContents, point.x, point.y)
      },
      { type: "separator" }
    ]
    if (hasPlayedAudio || muted) {
      template.push({
        label: muted ? "Unmute Tab" : "Mute Tab",
        click: () => this.actions.toggleMuted(owner, id)
      })
      template.push({ type: "separator" })
    }
    if (this.sendTargets.length) {
      template.push({
        label: "Send Tab to Device",
        submenu: this.sendTargets.map((target) => ({
          label: target.name,
          click: () => { if (!owner.window.isDestroyed()) owner.window.webContents.send(ELECTRON_IPC.tabSyncSendTab, id, target.deviceId) }
        }))
      }, { type: "separator" })
    }
    template.push(
      { label: "Duplicate Tab", click: () => void this.actions.duplicate(owner, id) },
      { label: "Move Tab to New Window", click: () => void this.actions.detach(owner, id) },
      { label: "Close Tab", click: () => this.actions.close(owner, id) }
    )
    Menu.buildFromTemplate(template).popup({ window: owner.window })
  }

  /**
   * Address bar menu: the standard edit items plus "Paste and Go". Resolves
   * with the clipboard text when Paste and Go was chosen, otherwise null; the
   * shell then navigates through the same path as pressing Enter.
   */
  async showAddressMenu(owner: WindowEntry, point: ElectronPoint): Promise<string | null> {
    if (!Number.isFinite(point?.x) || !Number.isFinite(point?.y)) {
      throw new Error("Invalid point")
    }
    const pasted = (await clipboard.readText()).trim()
    if (owner.window.isDestroyed()) return null
    return new Promise((resolve) => {
      const contents = owner.window.webContents
      const template: MenuItemConstructorOptions[] = [
        { label: "Inspect", click: () => this.inspect(contents, point.x, point.y) },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { label: "Paste and Go", enabled: pasted.length > 0, click: () => resolve(pasted) },
        { type: "separator" },
        { role: "selectAll" }
      ]
      Menu.buildFromTemplate(template).popup({
        window: owner.window,
        callback: () => resolve(null)
      })
    })
  }

  showContentsMenu(
    owner: WindowEntry,
    contents: WebContents,
    params: ContextMenuParams
  ): void {
    if (owner.window.isDestroyed() || contents.isDestroyed()) return
    const template: MenuItemConstructorOptions[] = [
      { label: "Inspect", click: () => this.inspect(contents, params.x, params.y) }
    ]

    if (params.isEditable) {
      template.push(
        { type: "separator" },
        { role: "cut", enabled: params.editFlags.canCut },
        { role: "copy", enabled: params.editFlags.canCopy },
        { role: "paste", enabled: params.editFlags.canPaste },
        { role: "selectAll", enabled: params.editFlags.canSelectAll }
      )
    } else if (params.selectionText) {
      const selection = params.selectionText
      template.push(
        { type: "separator" },
        { label: "Copy", click: () => clipboard.writeText(selection) },
        {
          label: "Search the Web",
          click: () => void this.actions.createTab(
            owner,
            `https://www.google.com/search?q=${encodeURIComponent(selection)}`,
            true
          )
        }
      )
    }

    const link = this.actions.normalizeUrl(params.linkURL)
    if (link) {
      template.push(
        { type: "separator" },
        { label: "Open in New Tab", click: () => void this.actions.createTab(owner, link, true) },
        { label: "Open in Background Tab", click: () => void this.actions.createTab(owner, link, false) },
        { label: "Open in New Once Window", click: () => void this.actions.createWindow(link) },
        { label: "Open in Default Browser", click: () => void shell.openExternal(link) },
        { label: "Copy Link Address", click: () => clipboard.writeText(link) }
      )
    }

    // Add-on trays for the page itself, and for a link under the cursor. The
    // shell's own window is no page, and neither is a blank or internal tab.
    const source = sourceUrlFromReaderUrl(params.pageURL ?? "") ?? params.pageURL
    const page = contents !== owner.window.webContents && isWebUrl(source) ? source : null
    const pageActions = page ? this.pageActions.for(owner, page) : []
    const linkActions = page && link && isWebUrl(link) ? this.pageActions.for(owner, link) : []
    if (pageActions.length || linkActions.length) template.push({ type: "separator" })
    for (const action of pageActions) {
      template.push({
        label: action.label,
        click: () => this.pageActions.run(owner, action.id, { href: page as string, title: contents.isDestroyed() ? "" : contents.getTitle() })
      })
    }
    for (const action of linkActions) {
      template.push({
        label: `${action.label} for Link`,
        click: () => this.pageActions.run(owner, action.id, { href: link as string, title: params.linkText })
      })
    }

    Menu.buildFromTemplate(template).popup({ window: owner.window })
  }

  showStoryMenu(
    owner: WindowEntry,
    items: ElectronStoryMenuItem[],
    point: ElectronPoint
  ): Promise<string | null> {
    return new Promise((resolve) => {
      const template: MenuItemConstructorOptions[] = []
      let lastGroup = ""
      for (const item of items.filter((entry) => entry.visible)) {
        if (lastGroup && item.group !== lastGroup) {
          template.push({ type: "separator" })
        }
        lastGroup = item.group
        template.push({
          label: item.label,
          enabled: item.enabled,
          click: () => {
            if (item.id === "inspect") {
              this.inspect(owner.window.webContents, point.x, point.y)
              resolve(null)
            } else {
              resolve(item.id)
            }
          }
        })
      }
      Menu.buildFromTemplate(template).popup({
        window: owner.window,
        callback: () => resolve(null)
      })
    })
  }

  private inspect(contents: WebContents, x: number, y: number): void {
    if (contents.isDestroyed()) return
    contents.inspectElement(Math.round(x), Math.round(y))
    setTimeout(() => {
      if (!contents.isDestroyed() && contents.isDevToolsOpened()) {
        contents.devToolsWebContents?.focus()
      }
    }, 0)
  }
}
