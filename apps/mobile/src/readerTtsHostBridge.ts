import { QueueStrategy, TextToSpeech } from "@capacitor-community/text-to-speech"
import {
  READER_TTS_CHANNEL,
  READER_TTS_VERSION,
  isReaderTtsRequest,
  ReaderTtsEventBody,
  ReaderTtsRequest,
  ReaderTtsVoice
} from "./readerTtsProtocol"

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

export interface ReaderTtsHostController {
  send(message: ReaderTtsEventBody): void
  subscribe(
    listener: (state: Extract<ReaderTtsRequest, { type: "ui-state" }>) => void
  ): () => void
}

/**
 * Host-page half of the reader TTS bridge: receives speech requests from the
 * sandboxed reader frame (see readerTtsPolyfill.ts) and drives the native
 * text-to-speech plugin. Utterances queue natively (QueueStrategy.Add) so
 * paragraph transitions stay gapless; a cancel bumps the generation so
 * settlements of stopped utterances are never reported back as playback events.
 */
export function installReaderTtsHostBridge(
  isReaderWindow: (source: MessageEventSource | null) => boolean,
  engine: ReaderTtsEngine = TextToSpeech,
  host: ReaderTtsHostWindow = window
): ReaderTtsHostController {
  let generation = 0
  let queueTail: Promise<void> = Promise.resolve()
  let uiSource: Window | null = null
  let uiSessionId = ""
  const uiListeners = new Set<
    (state: Extract<ReaderTtsRequest, { type: "ui-state" }>) => void
  >()

  host.addEventListener("message", (event) => {
    const request = event.data as ReaderTtsRequest | undefined
    if (!isReaderTtsRequest(request)) return
    const source = event.source
    if (!source || !isReaderWindow(source)) return
    const reply = (
      message: ReaderTtsEventBody
    ): void => {
      ;(source as Window).postMessage({
        ...message,
        channel: READER_TTS_CHANNEL,
        version: READER_TTS_VERSION,
        sessionId: request.sessionId
      }, "*")
    }

    if (request.type === "ui-state") {
      uiSource = source as Window
      uiSessionId = request.sessionId
      uiListeners.forEach((listener) => listener(request))
      return
    }

    if (request.type === "cancel") {
      generation += 1
      queueTail = Promise.resolve()
      void engine.stop().catch(() => undefined)
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
    send(message) {
      if (!uiSource || !uiSessionId) return
      uiSource.postMessage({
        ...message,
        channel: READER_TTS_CHANNEL,
        version: READER_TTS_VERSION,
        sessionId: uiSessionId
      }, "*")
    },
    subscribe(listener) {
      uiListeners.add(listener)
      return () => uiListeners.delete(listener)
    }
  }
}
