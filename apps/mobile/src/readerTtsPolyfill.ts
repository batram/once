import {
  READER_TTS_CHANNEL,
  ReaderTtsEvent,
  ReaderTtsRequest,
  ReaderTtsVoice
} from "./readerTtsProtocol"

export interface ReaderTtsPolyfillTarget {
  parent: unknown
  speechSynthesis?: unknown
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  document?: { documentElement?: { lang?: string } }
  navigator?: { language?: string }
}

interface QueueEntry {
  id: number
  utterance: BridgedUtterance
}

interface BridgedUtterance {
  text: string
  lang: string
  rate: number
  voice: ReaderTtsVoice | null
  onstart: ((event: unknown) => void) | null
  onend: ((event: unknown) => void) | null
  onerror: ((event: { error: string }) => void) | null
}

/**
 * Backfills speechSynthesis + SpeechSynthesisUtterance inside the sandboxed
 * reader frame by relaying utterances to the host page over postMessage. The
 * opaque-origin frame cannot reach the Capacitor bridge itself; the host side
 * lives in readerTtsHostBridge.ts. Native Android TTS cannot pause, so pause
 * stops playback and resume restarts from the interrupted utterance.
 *
 * `force` replaces an existing Web Speech implementation. The mobile app
 * always forces the bridge: WKWebView ships speechSynthesis, but on several
 * iOS versions getVoices() stays empty and playback never starts, so presence
 * of the API says nothing about it working.
 */
export function installReaderTtsPolyfill(
  target: ReaderTtsPolyfillTarget,
  options: { force?: boolean } = {}
): void {
  if (target.speechSynthesis && !options.force) return
  if (target.parent === target || !target.parent) return

  const post = (request: ReaderTtsRequest): void => {
    ;(target.parent as { postMessage(message: unknown, targetOrigin: string): void })
      .postMessage(request, "*")
  }

  class BridgedSpeechSynthesisUtterance implements BridgedUtterance {
    text: string
    lang = ""
    pitch = 1
    rate = 1
    volume = 1
    voice: ReaderTtsVoice | null = null
    onstart: ((event: unknown) => void) | null = null
    onend: ((event: unknown) => void) | null = null
    onerror: ((event: { error: string }) => void) | null = null
    onpause: unknown = null
    onresume: unknown = null
    onboundary: unknown = null
    onmark: unknown = null

    constructor(text = "") {
      this.text = String(text)
    }
  }

  class BridgedSpeechSynthesis extends EventTarget {
    paused = false
    pending = false
    speaking = false
    private voices: ReaderTtsVoice[] = []
    private queue: QueueEntry[] = []
    private nextId = 1

    constructor() {
      super()
      target.addEventListener("message", (event) => {
        if (event.source !== target.parent) return
        const message = event.data as ReaderTtsEvent | undefined
        if (!message || message.channel !== READER_TTS_CHANNEL) return
        this.receive(message)
      })
      post({ channel: READER_TTS_CHANNEL, type: "voices" })
    }

    getVoices(): ReaderTtsVoice[] {
      return this.voices.slice()
    }

    speak(utterance: BridgedUtterance): void {
      const entry = { id: this.nextId++, utterance }
      this.queue.push(entry)
      this.speaking = true
      if (!this.paused) post(this.speakRequest(entry))
    }

    cancel(): void {
      this.queue = []
      this.paused = false
      this.speaking = false
      post({ channel: READER_TTS_CHANNEL, type: "cancel" })
    }

    pause(): void {
      if (this.paused || this.queue.length === 0) return
      this.paused = true
      post({ channel: READER_TTS_CHANNEL, type: "cancel" })
    }

    resume(): void {
      if (!this.paused) return
      this.paused = false
      this.queue.forEach((entry) => post(this.speakRequest(entry)))
    }

    private receive(message: ReaderTtsEvent): void {
      if (message.type === "voices") {
        this.voices = message.voices
        this.dispatchEvent(new Event("voiceschanged"))
        return
      }
      const index = this.queue.findIndex((entry) => entry.id === message.id)
      if (index < 0) return
      const entry = this.queue[index]
      if (message.type === "start") {
        this.queue.splice(0, index)
        entry.utterance.onstart?.({ utterance: entry.utterance, charIndex: 0 })
        return
      }
      this.queue.splice(index, 1)
      if (this.queue.length === 0) this.speaking = false
      if (message.type === "end") {
        entry.utterance.onend?.({ utterance: entry.utterance, charIndex: 0 })
      } else {
        entry.utterance.onerror?.({ error: message.error })
      }
    }

    private speakRequest(entry: QueueEntry): ReaderTtsRequest {
      const { utterance } = entry
      const numericRate = Number(utterance.rate)
      const rate = Number.isFinite(numericRate)
        ? Math.min(6, Math.max(0.1, numericRate))
        : 1
      const voiceIndex = utterance.voice
        ? this.voices.findIndex((voice) => voice.voiceURI === utterance.voice?.voiceURI)
        : -1
      const lang = utterance.voice?.lang
        || utterance.lang
        || target.document?.documentElement?.lang
        || target.navigator?.language
        || ""
      return {
        channel: READER_TTS_CHANNEL,
        type: "speak",
        id: entry.id,
        text: String(utterance.text ?? ""),
        rate,
        ...(voiceIndex >= 0 ? { voice: voiceIndex } : {}),
        ...(lang ? { lang } : {})
      }
    }
  }

  Object.defineProperty(target, "speechSynthesis", {
    configurable: true,
    value: new BridgedSpeechSynthesis()
  })
  Object.defineProperty(target, "SpeechSynthesisUtterance", {
    configurable: true,
    value: BridgedSpeechSynthesisUtterance
  })
}
