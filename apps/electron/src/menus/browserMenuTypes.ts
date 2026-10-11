/** Commands the shell runs itself once the browser menu has closed. */
export type BrowserMenuCommand = "new-tab" | "new-window" | "close-tab" | "fullscreen"

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
  /** Chords bound to each command, as the shell's keybinding settings have them. */
  shortcuts: Partial<Record<BrowserMenuCommand, string>>
}

export interface BrowserMenuBridge {
  state(): Promise<BrowserMenuState>
  action(action: BrowserMenuAction): Promise<BrowserMenuState>
  /** The rendered height, so the window fits its rows. */
  ready(height: number): Promise<void>
}
