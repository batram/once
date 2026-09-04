import { BrowserWindow, WebContents } from "electron"
import { ExtensionShellHooks, TabSnapshot } from "../extensions/runtimeTypes"
import { TabEntry, WindowEntry } from "./BrowserState"
import { TabOwnership } from "./TabOwnership"

/** What the hooks need from the coordinator, by name rather than by class. */
export interface ExtensionTabAccess {
  ownership: TabOwnership
  createTab(owner: WindowEntry, url: string, active: boolean): Promise<string>
  navigate(owner: WindowEntry, id: string, url: string): Promise<void>
  toggleMuted(owner: WindowEntry, id: string): void
  close(owner: WindowEntry, id: string): void
  reload(owner: WindowEntry, id: string): void
}

/** Every tab as `browser.tabs` describes it; ids are webContents ids. */
export function tabSnapshots(ownership: TabOwnership): TabSnapshot[] {
  const snapshots: TabSnapshot[] = []
  for (const owner of ownership.windows.values()) {
    owner.tabs.forEach((id, index) => {
      const entry = ownership.get(id)
      // A destroyed view has no webContents at all; the entry outlives it
      // for one turn while ownership finalizes the close.
      const contents = entry?.view.webContents
      if (!entry || !contents || contents.isDestroyed()) return
      const active = owner.activeId === id
      snapshots.push({
        id: contents.id,
        windowId: owner.id,
        index,
        url: entry.displayedUrl,
        title: entry.title || "New tab",
        active,
        status: entry.loading ? "loading" : "complete",
        audible: entry.audible,
        mutedInfo: { muted: entry.muted },
        incognito: false,
        highlighted: active,
        pinned: false
      })
    })
  }
  return snapshots
}

/** The webContents id of the window's active tab, the id extensions use. */
export function activeTabContentsId(ownership: TabOwnership, state: WindowEntry): number | undefined {
  const entry = state.activeId ? ownership.get(state.activeId) : undefined
  const contents = entry?.view.webContents
  if (!contents || contents.isDestroyed()) return undefined
  return contents.id
}

function findByContentsId(ownership: TabOwnership, id: number): [WindowEntry, TabEntry] | null {
  for (const entry of ownership.tabs.values()) {
    const contents = entry.view.webContents
    if (!contents || contents.isDestroyed() || contents.id !== id) continue
    const owner = ownership.ownerFor(entry)
    return owner ? [owner, entry] : null
  }
  return null
}

function preferredWindow(ownership: TabOwnership): WindowEntry | undefined {
  const focused = BrowserWindow.getFocusedWindow()
  const state = focused ? ownership.windows.get(focused.webContents.id) : undefined
  return state ?? ownership.windows.values().next().value
}

/**
 * What the extension runtime may know and do about tabs. Extensions see
 * webContents ids, the shell keeps its own ids; this is where they meet.
 */
export function createExtensionTabHooks(
  access: ExtensionTabAccess,
  tabCreated: Set<(contents: WebContents) => void>
): ExtensionShellHooks {
  const { ownership } = access
  const require = (id: number): [WindowEntry, TabEntry] => {
    const found = findByContentsId(ownership, id)
    if (!found) throw new Error(`Invalid tab ID: ${id}`)
    return found
  }
  const snapshotOf = (id: number): TabSnapshot | null =>
    tabSnapshots(ownership).find((tab) => tab.id === id) ?? null
  return {
    tabs: () => tabSnapshots(ownership),
    createTab: async (url, active) => {
      const owner = preferredWindow(ownership)
      if (!owner) return null
      const entry = ownership.get(await access.createTab(owner, url, active))
      return entry ? snapshotOf(entry.view.webContents.id) : null
    },
    updateTab: async (id, props) => {
      const [owner, entry] = require(id)
      if (props.url !== undefined) await access.navigate(owner, entry.id, props.url)
      if (props.active) ownership.activate(owner, entry.id)
      if (props.muted !== undefined && props.muted !== entry.muted) {
        access.toggleMuted(owner, entry.id)
      }
      return snapshotOf(id)
    },
    moveTab: async (id, index) => {
      const [owner, entry] = require(id)
      const others = owner.tabs.filter((candidate) => candidate !== entry.id)
      // `tabs.move` indexes the list with this tab removed; -1 means the end.
      const target = index < 0 || index >= others.length ? undefined : others[index]
      if (target !== entry.id) ownership.reorder(owner, entry.id, target)
      return snapshotOf(id)
    },
    removeTab: async (id) => {
      const [owner, entry] = require(id)
      access.close(owner, entry.id)
    },
    reloadTab: async (id) => {
      const [owner, entry] = require(id)
      access.reload(owner, entry.id)
    },
    onTabsChanged: (listener) => ownership.observe(listener),
    onTabCreated: (listener) => {
      tabCreated.add(listener)
      return () => {
        tabCreated.delete(listener)
      }
    }
  }
}
