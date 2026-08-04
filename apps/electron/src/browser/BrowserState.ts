import {
  BrowserWindow,
  Rectangle,
  WebContentsView
} from "electron"
import { TabHistorySnapshot } from "./ClosedTabs"

export interface ErrorPageState {
  url: string
  error: string
  retryable: boolean
}

export interface TabEntry {
  id: string
  view: WebContentsView
  ownerId: number
  title: string
  loading: boolean
  audible: boolean
  hasPlayedAudio: boolean
  muted: boolean
  displayedUrl: string
  loadError: string | null
  loadErrorRetryable: boolean
  errorPageUrl: string | null
  errorPages: Map<string, ErrorPageState>
  htmlFullscreen: boolean
  pickerSession: Promise<string | null> | null
  /**
   * Refreshed on navigation so reopening a closed tab can restore its history.
   * It cannot be read at close time: the webContents is destroyed by then.
   */
  historySnapshot: TabHistorySnapshot | null
}

export interface WindowEntry {
  window: BrowserWindow
  tabs: string[]
  activeId: string | null
  backgroundColor: string
  backgroundReady: Promise<void>
  resolveBackgroundReady: () => void
  bounds: Rectangle
  normalBounds: Rectangle | null
  fullscreen: boolean
  closing: boolean
  /** Chords the renderer asked the main process to steal from focused pages. */
  forwardedKeys: Set<string>
}
