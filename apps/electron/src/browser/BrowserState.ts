import {
  BrowserWindow,
  Rectangle,
  WebContentsView
} from "electron"

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
  muted: boolean
  displayedUrl: string
  loadError: string | null
  loadErrorRetryable: boolean
  errorPageUrl: string | null
  errorPages: Map<string, ErrorPageState>
  htmlFullscreen: boolean
  pickerSession: Promise<string | null> | null
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
}
