export const READER_TTS_CHANNEL = "once-reader-tts"
export const READER_TTS_VERSION = 1

export interface ReaderTtsEnvelope {
  channel: typeof READER_TTS_CHANNEL
  version: typeof READER_TTS_VERSION
  sessionId: string
}

export interface ReaderTtsVoice {
  voiceURI: string
  name: string
  lang: string
  default: boolean
  localService: boolean
}

export type ReaderTtsRequestBody =
  | { type: "voices" }
  | { type: "cancel" }
  | {
    type: "ui-state"
    playing: boolean
    paused: boolean
    rate: number
    segment: number
    voices: ReaderTtsVoice[]
    voice: string
  }
  | {
    type: "speak"
    id: number
    text: string
    rate: number
    voice?: number
    lang?: string
  }
export type ReaderTtsRequest = ReaderTtsEnvelope & ReaderTtsRequestBody

export type ReaderTtsEventBody =
  | { type: "voices"; voices: ReaderTtsVoice[] }
  | { type: "start"; id: number }
  | { type: "end"; id: number }
  | { type: "error"; id: number; error: string }
  | { type: "state"; playing: boolean; rate: number; segment: number }
  | { type: "ui-play-toggle" }
  | { type: "ui-stop" }
  | { type: "ui-prev" }
  | { type: "ui-next" }
  | { type: "ui-set-rate"; rate: number }
  | { type: "ui-set-voice"; voice: string }
export type ReaderTtsEvent = ReaderTtsEnvelope & ReaderTtsEventBody

export function isReaderTtsEnvelope(value: unknown): value is ReaderTtsEnvelope {
  if (!value || typeof value !== "object") return false
  const candidate = value as Partial<ReaderTtsEnvelope>
  return candidate.channel === READER_TTS_CHANNEL &&
    candidate.version === READER_TTS_VERSION &&
    typeof candidate.sessionId === "string" &&
    candidate.sessionId.length > 0
}

export function isReaderTtsRequest(value: unknown): value is ReaderTtsRequest {
  if (!isReaderTtsEnvelope(value)) return false
  const candidate = value as Partial<ReaderTtsRequest>
  if (candidate.type === "voices" || candidate.type === "cancel") return true
  if (candidate.type === "ui-state") {
    return typeof candidate.playing === "boolean" &&
      typeof candidate.paused === "boolean" &&
      typeof candidate.rate === "number" &&
      Number.isInteger(candidate.segment) &&
      Array.isArray(candidate.voices) &&
      typeof candidate.voice === "string"
  }
  if (candidate.type !== "speak") return false
  return Number.isInteger(candidate.id) &&
    typeof candidate.text === "string" &&
    typeof candidate.rate === "number" &&
    Number.isFinite(candidate.rate) &&
    (candidate.voice == null || Number.isInteger(candidate.voice)) &&
    (candidate.lang == null || typeof candidate.lang === "string")
}

export function isReaderTtsEvent(value: unknown): value is ReaderTtsEvent {
  if (!isReaderTtsEnvelope(value)) return false
  const candidate = value as Partial<ReaderTtsEvent>
  if (candidate.type === "voices") return Array.isArray(candidate.voices)
  if (
    candidate.type === "ui-play-toggle" ||
    candidate.type === "ui-stop" ||
    candidate.type === "ui-prev" ||
    candidate.type === "ui-next"
  ) return true
  if (candidate.type === "ui-set-rate") {
    return typeof candidate.rate === "number" && Number.isFinite(candidate.rate)
  }
  if (candidate.type === "ui-set-voice") return typeof candidate.voice === "string"
  if (candidate.type === "state") {
    return typeof candidate.playing === "boolean" &&
      typeof candidate.rate === "number" &&
      Number.isInteger(candidate.segment)
  }
  if (
    candidate.type !== "start" &&
    candidate.type !== "end" &&
    candidate.type !== "error"
  ) return false
  return Number.isInteger(candidate.id) &&
    (candidate.type !== "error" || typeof candidate.error === "string")
}
