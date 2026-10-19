// Types shared by the runtime, the hosts and the API handlers. The shell
// (Electron's BrowserCoordinator, Lite's surface plugin) implements the
// hooks; the runtime never reaches into tab ownership directly.

export type { ExtensionPlatformOs, RuntimePlatform } from "./hostServices"

/** A browser tab as `browser.tabs` describes it. `id` is the host's tab id. */
export interface TabSnapshot {
  id: number
  windowId: number
  index: number
  url: string
  title: string
  active: boolean
  status: "loading" | "complete"
  audible: boolean
  mutedInfo: { muted: boolean }
  incognito: false
  highlighted: boolean
  pinned: false
}

export interface TabUpdateProps {
  url?: string
  active?: boolean
  muted?: boolean
}

/**
 * What the API handlers may know and do about tabs. A host adds its own
 * tab-creation hook on top (Electron's carries the new `WebContents`).
 */
export interface ExtensionShellHooks {
  tabs(): TabSnapshot[]
  createTab(url: string, active: boolean): Promise<TabSnapshot | null>
  updateTab(id: number, props: TabUpdateProps): Promise<TabSnapshot | null>
  /** Reorders within the tab's window; -1 or past the end means last. */
  moveTab(id: number, index: number): Promise<TabSnapshot | null>
  removeTab(id: number): Promise<void>
  reloadTab(id: number): Promise<void>
  /** Called whenever the tab list, order, or activation changes. */
  onTabsChanged(listener: () => void): () => void
}
