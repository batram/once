export interface ReaderSpeechVoice {
  voiceURI: string
  name: string
  lang: string
  default: boolean
  localService: boolean
}

export interface ReaderSpeechState {
  playing: boolean
  paused: boolean
  rate: number
  segment: number
  voices: ReaderSpeechVoice[]
  voice: string
}

export interface ReaderSpeechEngine {
  cancel(): void
  pause(): void
  resume(): void
  speak(utterance: SpeechSynthesisUtterance): void
  getVoices(): SpeechSynthesisVoice[]
}

export interface ReaderSpeechSessionOptions {
  engine: ReaderSpeechEngine
  createUtterance: (text: string) => SpeechSynthesisUtterance
  texts: string[]
  initialRate: number
  claimOwnership?: () => void
  releaseOwnership?: () => void
  ownershipChannel?: {
    postMessage(message: unknown): void
    addEventListener(type: "message", listener: (event: MessageEvent) => void): void
    close(): void
  }
  ownerId?: string
  onPositionChange?: (position: number) => void
  onStateChange?: (state: ReaderSpeechState) => void
  onError?: (error: string) => void
}

export class ReaderSpeechSession {
  private active = false
  private paused = false
  private position = 0
  private generation = 0
  private rate: number
  private voice = ""

  constructor(private readonly options: ReaderSpeechSessionOptions) {
    this.rate = options.initialRate
    options.ownershipChannel?.addEventListener("message", (event) => {
      const message = event.data as { type?: string; ownerId?: string } | null
      if (message?.type === "claim" && message.ownerId !== options.ownerId) this.yield()
    })
  }

  get state(): ReaderSpeechState {
    return {
      playing: this.active,
      paused: this.paused,
      rate: this.rate,
      segment: this.position,
      voices: this.options.engine.getVoices().map((voice) => ({
        voiceURI: voice.voiceURI,
        name: voice.name,
        lang: voice.lang,
        default: voice.default,
        localService: voice.localService
      })),
      voice: this.voice
    }
  }

  notify(): void {
    this.options.onStateChange?.(this.state)
  }

  toggle(): void {
    if (!this.active) this.start()
    else if (this.paused) {
      this.options.engine.resume()
      this.paused = false
      this.notify()
    } else {
      this.options.engine.pause()
      this.paused = true
      this.notify()
    }
  }

  start(from = this.position): void {
    this.options.claimOwnership?.()
    this.options.ownershipChannel?.postMessage({
      type: "claim",
      ownerId: this.options.ownerId
    })
    this.options.engine.cancel()
    const run = ++this.generation
    this.position = Math.max(0, Math.min(from, Math.max(0, this.options.texts.length - 1)))
    this.active = this.options.texts.length > 0
    this.paused = false
    this.notify()
    if (!this.active) return

    for (let index = this.position; index < this.options.texts.length; index += 1) {
      const utterance = this.options.createUtterance(this.options.texts[index])
      utterance.rate = this.rate
      utterance.voice = this.selectedVoice() ?? null
      utterance.onstart = () => {
        if (run !== this.generation) return
        this.position = index
        this.options.onPositionChange?.(index)
        this.notify()
      }
      utterance.onend = () => {
        if (run === this.generation && index === this.options.texts.length - 1) this.finish()
      }
      utterance.onerror = (event) => {
        if (run !== this.generation || event.error === "canceled" || event.error === "interrupted") return
        this.finish()
        this.options.onError?.(event.error)
      }
      this.options.engine.speak(utterance)
    }
  }

  stop(): void {
    this.cancel(true)
  }

  dispose(): void {
    this.stop()
    this.options.ownershipChannel?.close()
  }

  yield(): void {
    this.cancel(false)
  }

  previous(): void {
    if (this.active) this.start(this.position - 1)
  }

  next(): void {
    if (this.active) this.start(this.position + 1)
  }

  setRate(rate: number): void {
    this.rate = Math.min(6, Math.max(0.5, rate))
    if (this.active) this.start(this.position)
    else this.notify()
  }

  previewRate(rate: number): void {
    this.rate = Math.min(6, Math.max(0.5, rate))
    this.notify()
  }

  setVoice(voice: string): void {
    this.voice = voice
    if (this.active) this.start(this.position)
    else this.notify()
  }

  private cancel(resetPosition: boolean): void {
    this.generation += 1
    this.options.engine.cancel()
    this.finish(resetPosition)
  }

  private finish(resetPosition = true): void {
    this.active = false
    this.paused = false
    if (resetPosition) this.position = 0
    else this.options.onPositionChange?.(this.position)
    this.notify()
    this.options.releaseOwnership?.()
  }

  private selectedVoice(): SpeechSynthesisVoice | undefined {
    return this.options.engine.getVoices().find((voice) => voice.voiceURI === this.voice)
  }
}
