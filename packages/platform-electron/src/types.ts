export interface ElectronRect {
  x: number
  y: number
  width: number
  height: number
}

export interface ElectronTabState {
  id: string
  url: string
  title: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  audible: boolean
  active: boolean
}

export interface ElectronFetchRequest {
  url: string
  method: string
  headers: [string, string][]
  body?: ArrayBuffer
}

export interface ElectronFetchResponse {
  status: number
  statusText: string
  headers: [string, string][]
  body: ArrayBuffer
}

export type ElectronOpenTarget = "_self" | "middle" | "blank" | string

export interface ElectronBridge {
  fetch(request: ElectronFetchRequest): Promise<ElectronFetchResponse>
  settings: {
    getSyncUrl(): Promise<string>
    setSyncUrl(syncUrl: string): Promise<void>
    getCacheTime(): Promise<number>
    setCacheTime(cacheTime: string): Promise<void>
  }
  tabs: {
    getAll(): Promise<ElectronTabState[]>
    openUrl(url: string, target: ElectronOpenTarget): Promise<void>
    create(url?: string, active?: boolean): Promise<string>
    activate(id: string): Promise<void>
    close(id: string): Promise<void>
    navigate(id: string, url: string): Promise<void>
    back(id: string): Promise<void>
    forward(id: string): Promise<void>
    reload(id: string): Promise<void>
    stop(id: string): Promise<void>
    setBounds(bounds: ElectronRect): Promise<void>
    onChanged(handler: (tabs: ElectronTabState[]) => void): () => void
  }
}

export const ELECTRON_IPC = {
  fetch: "once:fetch",
  getSyncUrl: "once:settings:get-sync-url",
  setSyncUrl: "once:settings:set-sync-url",
  getCacheTime: "once:settings:get-cache-time",
  setCacheTime: "once:settings:set-cache-time",
  tabsGetAll: "once:tabs:get-all",
  tabsOpenUrl: "once:tabs:open-url",
  tabsCreate: "once:tabs:create",
  tabsActivate: "once:tabs:activate",
  tabsClose: "once:tabs:close",
  tabsNavigate: "once:tabs:navigate",
  tabsBack: "once:tabs:back",
  tabsForward: "once:tabs:forward",
  tabsReload: "once:tabs:reload",
  tabsStop: "once:tabs:stop",
  tabsSetBounds: "once:tabs:set-bounds",
  tabsChanged: "once:tabs:changed"
} as const

declare global {
  interface Window {
    onceElectron: ElectronBridge
  }
}
