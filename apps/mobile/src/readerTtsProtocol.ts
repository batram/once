export const READER_TTS_CHANNEL = "once-reader-tts"

export interface ReaderTtsVoice {
  voiceURI: string
  name: string
  lang: string
  default: boolean
  localService: boolean
}

export type ReaderTtsRequest =
  | { channel: typeof READER_TTS_CHANNEL; type: "voices" }
  | { channel: typeof READER_TTS_CHANNEL; type: "cancel" }
  | {
    channel: typeof READER_TTS_CHANNEL
    type: "speak"
    id: number
    text: string
    rate: number
    voice?: number
    lang?: string
  }

export type ReaderTtsEvent =
  | { channel: typeof READER_TTS_CHANNEL; type: "voices"; voices: ReaderTtsVoice[] }
  | { channel: typeof READER_TTS_CHANNEL; type: "start"; id: number }
  | { channel: typeof READER_TTS_CHANNEL; type: "end"; id: number }
  | { channel: typeof READER_TTS_CHANNEL; type: "error"; id: number; error: string }
