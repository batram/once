// Main-process types shared by the runtime, hosts, and API handlers. The
// shell (BrowserCoordinator) implements the hooks; the runtime never reaches
// into tab ownership directly.

/** A browser tab as `browser.tabs` describes it. `id` is the webContents id. */
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

export interface ExtensionShellHooks {
  tabs(): TabSnapshot[]
  createTab(url: string, active: boolean): Promise<TabSnapshot | null>
  updateTab(id: number, props: TabUpdateProps): Promise<TabSnapshot | null>
  removeTab(id: number): Promise<void>
  reloadTab(id: number): Promise<void>
  /** Called whenever the tab list, order, or activation changes. */
  onTabsChanged(listener: () => void): () => void
  /** Opens an extension page (options, dashboard) as a shell tab. */
  openExtensionPage(url: string): Promise<void>
}

export type ExtensionPlatformOs = "win" | "mac" | "linux"

export function platformOs(platform: NodeJS.Platform): ExtensionPlatformOs {
  if (platform === "win32") return "win"
  if (platform === "darwin") return "mac"
  return "linux"
}
