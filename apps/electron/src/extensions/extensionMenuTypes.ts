import { ElectronExtensionInfo } from "@once/platform-electron/bridge"

export interface ExtensionMenuState {
  infos: ElectronExtensionInfo[]
  pinned: string[]
}

export interface ExtensionMenuResult {
  pinned: string[]
  host?: string
  settings?: boolean
  focusTrigger?: boolean
}

export interface ExtensionMenuBridge {
  state(): Promise<ExtensionMenuState>
  action(action: "pin" | "open" | "settings" | "close", host?: string): Promise<ExtensionMenuState>
}
