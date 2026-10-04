import {
  READER_TTS_CHANNEL,
  READER_TTS_VERSION,
  ReaderTtsEventBody,
  ReaderTtsRequest
} from "./readerTtsProtocol"

export type ReaderUiState = Extract<ReaderTtsRequest, { type: "ui-state" }>
export type ReaderMediaAction = "play" | "pause" | "next" | "previous" | "stop"

/**
 * What the host knows about each tab's reader frame from its UI state: the
 * shell controls follow the selected reader, the audio indicator follows each
 * reader, and system media controls follow the reader whose article plays.
 */
export class ReaderTtsFrames {
  private readonly frames = new Map<Window, { sessionId: string; state: ReaderUiState; audible: boolean }>()
  private readonly uiListeners = new Set<(state: ReaderUiState) => void>()
  private readonly audibleListeners = new Set<(source: Window, audible: boolean) => void>()
  private readonly speechListeners = new Set<(frame: Window | null, state: ReaderUiState | null) => void>()
  private speechFrame: Window | null = null

  constructor(private readonly isSelectedReader: (source: MessageEventSource) => boolean) {}

  receive(frame: Window, state: ReaderUiState): void {
    const audible = this.frames.get(frame)?.audible ?? false
    this.frames.set(frame, { sessionId: state.sessionId, state, audible })
    this.setAudible(frame, state.playing && !state.paused)
    if (state.playing) this.setSpeech(frame, state)
    else if (this.speechFrame === frame) this.setSpeech(null, null)
    if (this.isSelectedReader(frame)) this.uiListeners.forEach((listener) => listener(state))
  }

  /** Posts a control message to a reader's UI session, if it reported one. */
  post(frame: Window, message: ReaderTtsEventBody): void {
    const sessionId = this.frames.get(frame)?.sessionId
    if (!sessionId) return
    frame.postMessage({ ...message, channel: READER_TTS_CHANNEL, version: READER_TTS_VERSION, sessionId }, "*")
  }

  send(message: ReaderTtsEventBody): void {
    const frame = this.selected()
    if (frame) this.post(frame, message)
  }

  subscribe(listener: (state: ReaderUiState) => void): () => void {
    this.uiListeners.add(listener)
    return () => this.uiListeners.delete(listener)
  }

  refresh(): void {
    const frame = this.selected()
    const state = frame && this.frames.get(frame)?.state
    if (state) this.uiListeners.forEach((listener) => listener(state))
  }

  onSpeech(listener: (frame: Window | null, state: ReaderUiState | null) => void): () => void {
    this.speechListeners.add(listener)
    return () => this.speechListeners.delete(listener)
  }

  command(action: ReaderMediaAction): void {
    const frame = this.speechFrame
    const state = frame && this.frames.get(frame)?.state
    if (!frame || !state) return
    const message: ReaderTtsEventBody | null =
      action === "play" ? (state.paused ? { type: "ui-play-toggle" } : null)
        : action === "pause" ? (state.paused ? null : { type: "ui-play-toggle" })
          : action === "next" ? { type: "ui-next" }
            : action === "previous" ? { type: "ui-prev" }
              : { type: "ui-stop" }
    if (message) this.post(frame, message)
  }

  onAudible(listener: (source: Window, audible: boolean) => void): () => void {
    this.audibleListeners.add(listener)
    return () => this.audibleListeners.delete(listener)
  }

  /** Forgets readers whose documents went away. */
  forget(isWindow: (source: MessageEventSource) => boolean): void {
    if (this.speechFrame && isWindow(this.speechFrame)) this.setSpeech(null, null)
    for (const frame of [...this.frames.keys()]) {
      if (!isWindow(frame)) continue
      this.setAudible(frame, false)
      this.frames.delete(frame)
    }
  }

  private selected(): Window | null {
    for (const frame of this.frames.keys()) if (this.isSelectedReader(frame)) return frame
    return null
  }

  private setSpeech(frame: Window | null, state: ReaderUiState | null): void {
    this.speechFrame = frame
    this.speechListeners.forEach((listener) => listener(frame, state))
  }

  private setAudible(frame: Window, audible: boolean): void {
    const entry = this.frames.get(frame)
    if (!entry || entry.audible === audible) return
    entry.audible = audible
    this.audibleListeners.forEach((listener) => listener(frame, audible))
  }
}
