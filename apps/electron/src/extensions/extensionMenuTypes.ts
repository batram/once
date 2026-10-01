import { ElectronExtensionInfo, ElectronToolbarTool } from "@once/platform-electron/bridge"

export interface ExtensionMenuState {
  infos: ElectronExtensionInfo[]
  /** Shell buttons listed above the extensions: reader mode and add-on actions. */
  tools: ElectronToolbarTool[]
  /** Extension hosts and tool ids shown on the toolbar. */
  pinned: string[]
}

export interface ExtensionMenuResult {
  pinned: string[]
  host?: string
  tool?: string
  settings?: boolean
  focusTrigger?: boolean
}

export interface ExtensionMenuBridge {
  state(): Promise<ExtensionMenuState>
  action(action: "pin" | "open" | "settings" | "close", host?: string): Promise<ExtensionMenuState>
}
