/** Commands the shell runs itself once the browser menu has closed. */
export type BrowserMenuCommand = "new-tab" | "new-window" | "close-tab" | "fullscreen" | "history"

/** Everything the menu can ask of main; zoom keeps the menu open. */
export type BrowserMenuAction =
  | BrowserMenuCommand
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "clear-site"
  | "close"

export interface BrowserMenuState {
  /** The active tab's zoom factor; null without a tab. */
  zoom: number | null
  /** The site whose data can be cleared; null off the web. */
  site: string | null
  fullscreen: boolean
  /** The devices the active tab can be sent to; empty without a web page or a device to take it. */
  devices: Array<{ deviceId: string; name: string }>
  /** Chords bound to each command, as the shell's keybinding settings have them. */
  shortcuts: Partial<Record<BrowserMenuCommand, string>>
}

export interface BrowserMenuBridge {
  state(): Promise<BrowserMenuState>
  action(action: BrowserMenuAction): Promise<BrowserMenuState>
  /** Sends the active tab to one of the listed devices and closes the menu. */
  send(deviceId: string): Promise<void>
  /** Opens the device submenu beside `row`; `focus` hands it the keyboard. */
  openDevices(row: { x: number; y: number; width: number; height: number }, focus: boolean): Promise<void>
  /** Closes the device submenu, from either popup. */
  closeDevices(): Promise<void>
  /** The device submenu closed, however it did. */
  onDevicesClosed(handler: () => void): void
  /** The rendered height, so the window fits its rows. */
  ready(height: number): Promise<void>
  /** The tab changed under the open menu, such as Ctrl+wheel zoom over the page. */
  onStateChanged(handler: (state: BrowserMenuState) => void): void
}
