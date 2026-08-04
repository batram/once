import { ELECTRON_IPC, ElectronTabState } from "@once/platform-electron/bridge"
import { releaseErrorPages } from "./ErrorPageProtocol"
import { NavigationErrors } from "./NavigationErrors"
import { TabEntry, WindowEntry } from "./BrowserState"
import { ClosedTabs } from "./ClosedTabs"

interface TabOwnershipActions {
  createBlankTab(owner: WindowEntry): Promise<unknown>
}

export class TabOwnership {
  readonly tabs = new Map<string, TabEntry>()
  readonly windows = new Map<number, WindowEntry>()
  readonly closedTabs = new ClosedTabs()

  constructor(
    private readonly errors: NavigationErrors,
    private readonly actions: TabOwnershipActions
  ) {}

  addWindow(owner: WindowEntry): void {
    this.windows.set(owner.window.webContents.id, owner)
  }

  removeWindow(owner: WindowEntry): void {
    this.windows.delete(owner.window.webContents.id)
  }

  addTab(owner: WindowEntry, entry: TabEntry): void {
    this.tabs.set(entry.id, entry)
    owner.tabs.push(entry.id)
  }

  get(id: string): TabEntry | undefined {
    return this.tabs.get(id)
  }

  ownerFor(entry: TabEntry): WindowEntry | undefined {
    return this.windows.get(entry.ownerId)
  }

  requireOwned(owner: WindowEntry, id: string): TabEntry {
    const entry = this.tabs.get(id)
    if (!entry || entry.ownerId !== owner.window.webContents.id) {
      throw new Error(`Unknown tab: ${id}`)
    }
    return entry
  }

  getAll(owner: WindowEntry): ElectronTabState[] {
    return owner.tabs.flatMap((id) => {
      const entry = this.tabs.get(id)
      if (!entry) return []
      const contents = entry.view.webContents
      return [{
        id,
        url: entry.displayedUrl,
        title: entry.title || "New tab",
        loading: entry.loading,
        canGoBack: !contents.isDestroyed() && this.errors.backTargetIndex(entry) >= 0,
        canGoForward:
          !contents.isDestroyed() && contents.navigationHistory.canGoForward(),
        audible: entry.audible,
        hasPlayedAudio: entry.hasPlayedAudio,
        muted: entry.muted,
        active: id === owner.activeId,
        loadError: entry.loadError
      }]
    })
  }

  activate(owner: WindowEntry, id: string): void {
    const entry = this.requireOwned(owner, id)
    if (owner.activeId === id) return
    const previous = owner.activeId ? this.tabs.get(owner.activeId) : undefined
    if (previous) owner.window.contentView.removeChildView(previous.view)
    owner.activeId = id
    owner.window.contentView.addChildView(entry.view)
    if (owner.bounds.width > 0 && owner.bounds.height > 0) {
      entry.view.setBounds(owner.bounds)
    }
    entry.view.webContents.focus()
    this.notify(owner)
  }

  reorder(owner: WindowEntry, id: string, beforeId?: string): void {
    this.requireOwned(owner, id)
    if (beforeId) this.requireOwned(owner, beforeId)
    this.insert(owner.tabs, id, beforeId)
    this.notify(owner)
  }

  move(owner: WindowEntry, id: string, beforeId?: string): void {
    const entry = this.tabs.get(id)
    if (!entry) throw new Error(`Unknown tab: ${id}`)
    const source = this.windows.get(entry.ownerId)
    if (!source) throw new Error("Tab owner is unavailable")
    if (source === owner) {
      this.reorder(owner, id, beforeId)
      return
    }
    const oldIndex = source.tabs.indexOf(id)
    if (source.activeId === id) {
      source.window.contentView.removeChildView(entry.view)
      source.activeId = null
    }
    source.tabs.splice(oldIndex, 1)
    entry.ownerId = owner.window.webContents.id
    entry.view.setBackgroundColor(owner.backgroundColor)
    this.insert(owner.tabs, id, beforeId)
    this.activate(owner, id)
    this.fillActivationGap(source, oldIndex)
  }

  finalizeClosed(entry: TabEntry): void {
    if (!this.tabs.delete(entry.id)) return
    releaseErrorPages(entry.errorPages.keys())
    const owner = this.windows.get(entry.ownerId)
    if (!owner) return
    const index = owner.tabs.indexOf(entry.id)
    if (index < 0) return
    // Recorded before the splice so the tab can be reopened where it was.
    this.closedTabs.record(entry, owner, index)
    if (owner.activeId === entry.id) {
      owner.window.contentView.removeChildView(entry.view)
      owner.activeId = null
    }
    owner.tabs.splice(index, 1)
    if (owner.closing) return
    if (owner.tabs.length === 0) {
      if (this.windows.size > 1) this.closeEmptyWindow(owner)
      else void this.actions.createBlankTab(owner)
    } else if (!owner.activeId) {
      this.activate(owner, owner.tabs[Math.min(index, owner.tabs.length - 1)])
    } else {
      this.notify(owner)
    }
  }

  closeWindow(owner: WindowEntry): void {
    this.removeWindow(owner)
    for (const [index, id] of [...owner.tabs].entries()) {
      const entry = this.tabs.get(id)
      this.tabs.delete(id)
      // Closing a window is a bulk close: its tabs belong in the reopen stack
      // too, so Ctrl+Shift+T brings them back one at a time.
      if (entry) this.closedTabs.record(entry, owner, index)
      if (entry) releaseErrorPages(entry.errorPages.keys())
      if (entry && !entry.view.webContents.isDestroyed()) {
        entry.view.webContents.close({ waitForBeforeUnload: false })
      }
    }
    owner.tabs = []
    owner.activeId = null
  }

  notifyEntry(entry: TabEntry): void {
    const owner = this.ownerFor(entry)
    if (owner) this.notify(owner)
  }

  notify(owner: WindowEntry): void {
    if (!owner.window.isDestroyed()) {
      owner.window.webContents.send(ELECTRON_IPC.tabsChanged, this.getAll(owner))
    }
  }

  private fillActivationGap(source: WindowEntry, oldIndex: number): void {
    if (source.tabs.length > 0 && !source.activeId) {
      this.activate(source, source.tabs[Math.min(oldIndex, source.tabs.length - 1)])
    } else {
      this.notify(source)
    }
    if (source.tabs.length === 0 && this.windows.size > 1) {
      this.closeEmptyWindow(source)
    }
  }

  private closeEmptyWindow(owner: WindowEntry): void {
    owner.closing = true
    owner.window.destroy()
  }

  private insert(ids: string[], id: string, beforeId?: string): void {
    const oldIndex = ids.indexOf(id)
    if (oldIndex >= 0) ids.splice(oldIndex, 1)
    const targetIndex = beforeId ? ids.indexOf(beforeId) : -1
    if (targetIndex >= 0) ids.splice(targetIndex, 0, id)
    else ids.push(id)
  }
}
