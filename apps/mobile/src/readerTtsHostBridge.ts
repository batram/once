import { QueueStrategy, TextToSpeech } from "@capacitor-community/text-to-speech"
import {
  READER_TTS_CHANNEL,
  READER_TTS_VERSION,
  isReaderTtsRequest,
  ReaderTtsEventBody,
  ReaderTtsRequest,
  ReaderTtsVoice
} from "./readerTtsProtocol"
import { ReaderTtsFrames, type ReaderMediaAction, type ReaderUiState } from "./readerTtsFrames"

export interface ReaderTtsEngine {
  speak(options: {
    text: string
    rate?: number
    lang?: string
    voice?: number
    category?: string
    queueStrategy?: QueueStrategy
  }): Promise<void>
  stop(): Promise<void>
  getSupportedVoices(): Promise<{ voices: ReaderTtsVoice[] }>
}

export interface ReaderTtsHostWindow {
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
}

export type { ReaderMediaAction } from "./readerTtsFrames"

export interface ReaderTtsHostController {
  /** Posts a control message to the selected tab's reader. */
  send(message: ReaderTtsEventBody): void
  /** UI state of the selected tab's reader. */
  subscribe(
    listener: (state: ReaderUiState) => void
  ): () => void
  /** Replays the selected reader's last state, e.g. after a tab switch. */
  refresh(): void
  /** Whether a reader is audibly speaking, reported per reader window. */
  onAudible(listener: (source: Window, audible: boolean) => void): () => void
  /** A reader's document went away; its queued speech must not outlive it. */
  release(isWindow: (source: MessageEventSource) => boolean): void
  /**
   * The reader whose article is playing or paused (the one system media
   * controls act on), or null once it stopped; it need not be selected.
   */
  onSpeech(listener: (frame: Window | null, state: ReaderUiState | null) => void): () => void
  /** A system media control for the speaking reader. */
  command(action: ReaderMediaAction): void
}

/**
 * Host-page half of the reader TTS bridge: receives speech requests from the
 * sandboxed reader frames (see readerTtsPolyfill.ts) and drives the native
 * text-to-speech plugin. Utterances queue natively (QueueStrategy.Add) so
 * paragraph transitions stay gapless; a cancel bumps the generation so
 * settlements of stopped utterances are never reported back as playback events.
 *
 * Every tab's reader may speak, including background tabs, but there is one
 * native voice: the reader that queued the current speech owns it, and a
 * different reader starting to speak stops the owner first.
 */
export function installReaderTtsHostBridge(
  isReaderWindow: (source: MessageEventSource | null) => boolean,
  engine: ReaderTtsEngine = TextToSpeech,
  host: ReaderTtsHostWindow = window,
  isSelectedReader: (source: MessageEventSource) => boolean = () => true
): ReaderTtsHostController {
  let generation = 0
  let queueTail: Promise<void> = Promise.resolve()
  let owner: Window | null = null
  const frames = new ReaderTtsFrames(isSelectedReader)
  const stopEngine = (): void => {
    generation += 1
    queueTail = Promise.resolve()
    owner = null
    void engine.stop().catch(() => undefined)
  }

  host.addEventListener("message", (event) => {
    const request = event.data as ReaderTtsRequest | undefined
    if (!isReaderTtsRequest(request)) return
    const source = event.source
    if (!source || !isReaderWindow(source)) return
    const frame = source as Window
    const reply = (message: ReaderTtsEventBody): void => {
      frame.postMessage({
        ...message,
        channel: READER_TTS_CHANNEL,
        version: READER_TTS_VERSION,
        sessionId: request.sessionId
      }, "*")
    }

    if (request.type === "ui-state") {
      frames.receive(frame, request)
      return
    }

    if (request.type === "cancel") {
      // A preempted reader acknowledging its stop must not silence the new owner.
      if (owner && owner !== frame) return
      stopEngine()
      return
    }

    if (request.type === "voices") {
      void engine.getSupportedVoices()
        .then(({ voices }) => voices.map((voice) => ({
          voiceURI: voice.voiceURI,
          name: voice.name,
          lang: voice.lang,
          default: Boolean(voice.default),
          localService: Boolean(voice.localService)
        })))
        .catch(() => [] as ReaderTtsVoice[])
        .then((voices) => reply({ type: "voices", voices }))
      return
    }

    if (owner && owner !== frame) {
      const previous = owner
      stopEngine()
      frames.post(previous, { type: "ui-stop" })
    }
    owner = frame
    const run = generation
    const { id, text, rate, voice, lang } = request
    void queueTail.then(() => {
      if (run === generation) reply({ type: "start", id })
    })
    queueTail = engine.speak({
      text,
      rate,
      ...(voice != null ? { voice } : {}),
      ...(lang ? { lang } : {}),
      category: "playback",
      queueStrategy: QueueStrategy.Add
    }).then(
      () => {
        if (run === generation) reply({ type: "end", id })
      },
      () => {
        if (run === generation) reply({ type: "error", id, error: "interrupted" })
      }
    )
  })

  return {
    send: (message) => frames.send(message),
    subscribe: (listener) => frames.subscribe(listener),
    refresh: () => frames.refresh(),
    onSpeech: (listener) => frames.onSpeech(listener),
    command: (action) => frames.command(action),
    onAudible: (listener) => frames.onAudible(listener),
    release(isWindow) {
      if (owner && isWindow(owner)) stopEngine()
      frames.forget(isWindow)
    }
  }
}
