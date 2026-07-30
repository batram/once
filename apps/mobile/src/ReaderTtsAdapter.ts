import {
  READER_TTS_CHANNEL,
  READER_TTS_VERSION,
  isReaderTtsEvent,
  ReaderTtsEvent,
  ReaderTtsRequest,
  ReaderTtsVoice
} from "./readerTtsProtocol"

export interface ReaderTtsAdapterTarget {
  parent: unknown
  addEventListener(type: "message", listener: (event: MessageEvent) => void): void
  document?: { documentElement?: { lang?: string } }
  navigator?: { language?: string }
}

export class BridgedSpeechSynthesisUtterance {
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

interface QueueEntry {
  id: number
  utterance: BridgedSpeechSynthesisUtterance
}

export class ReaderTtsAdapter extends EventTarget {
  paused = false
  pending = false
  speaking = false
  private voices: ReaderTtsVoice[] = []
  private queue: QueueEntry[] = []
  private nextId = 1

  constructor(
    private readonly target: ReaderTtsAdapterTarget,
    private readonly sessionId = createReaderTtsSessionId()
  ) {
    super()
    target.addEventListener("message", (event) => {
      if (event.source !== target.parent) return
      const message = event.data as ReaderTtsEvent | undefined
      if (!isReaderTtsEvent(message) || message.sessionId !== sessionId) return
      this.receive(message)
    })
    this.post({ type: "voices" })
  }

  getVoices(): ReaderTtsVoice[] {
    return this.voices.slice()
  }

  speak(utterance: BridgedSpeechSynthesisUtterance): void {
    const entry = { id: this.nextId++, utterance }
    this.queue.push(entry)
    this.speaking = true
    if (!this.paused) this.post(this.speakRequest(entry))
  }

  cancel(): void {
    this.queue = []
    this.paused = false
    this.speaking = false
    this.post({ type: "cancel" })
  }

  pause(): void {
    if (this.paused || this.queue.length === 0) return
    this.paused = true
    this.post({ type: "cancel" })
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    this.queue.forEach((entry) => this.post(this.speakRequest(entry)))
  }

  private receive(message: ReaderTtsEvent): void {
    if (message.type === "voices") {
      this.voices = message.voices
      this.dispatchEvent(new Event("voiceschanged"))
      return
    }
    if (message.type === "state") return
    if (
      message.type !== "start" &&
      message.type !== "end" &&
      message.type !== "error"
    ) return
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
      || this.target.document?.documentElement?.lang
      || this.target.navigator?.language
      || ""
    return this.envelope({
      type: "speak",
      id: entry.id,
      text: String(utterance.text ?? ""),
      rate,
      ...(voiceIndex >= 0 ? { voice: voiceIndex } : {}),
      ...(lang ? { lang } : {})
    })
  }

  private post(body: { type: "voices" } | { type: "cancel" } | ReaderTtsRequest): void {
    const request = "channel" in body ? body : this.envelope(body)
    ;(this.target.parent as {
      postMessage(message: unknown, targetOrigin: string): void
    }).postMessage(request, "*")
  }

  private envelope<T extends { type: string }>(
    body: T
  ): T & {
    channel: typeof READER_TTS_CHANNEL
    version: typeof READER_TTS_VERSION
    sessionId: string
  } {
    return {
      ...body,
      channel: READER_TTS_CHANNEL,
      version: READER_TTS_VERSION,
      sessionId: this.sessionId
    }
  }
}

function createReaderTtsSessionId(): string {
  return `reader-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
}
