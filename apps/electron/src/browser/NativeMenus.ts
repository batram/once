import {
  clipboard,
  ContextMenuParams,
  Menu,
  MenuItemConstructorOptions,
  shell,
  WebContents
} from "electron"
import { ElectronPoint } from "@once/platform-electron/bridge"
import { WindowEntry } from "./BrowserState"

interface NativeMenuActions {
  close(owner: WindowEntry, id: string): void
  createTab(owner: WindowEntry, url: string, active: boolean): Promise<string>
  createWindow(url: string): Promise<void>
  detach(owner: WindowEntry, id: string): Promise<void>
  duplicate(owner: WindowEntry, id: string): Promise<string>
  normalizeUrl(url: string): string | null
}

export class NativeMenus {
  constructor(private readonly actions: NativeMenuActions) {}

  showTabMenu(owner: WindowEntry, id: string, point: ElectronPoint): void {
    const template: MenuItemConstructorOptions[] = [
      {
        label: "Inspect",
        click: () => this.inspect(owner.window.webContents, point.x, point.y)
      },
      { type: "separator" },
      { label: "Duplicate Tab", click: () => void this.actions.duplicate(owner, id) },
      { label: "Move Tab to New Window", click: () => void this.actions.detach(owner, id) },
      { label: "Close Tab", click: () => this.actions.close(owner, id) }
    ]
    Menu.buildFromTemplate(template).popup({ window: owner.window })
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

    Menu.buildFromTemplate(template).popup({ window: owner.window })
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
