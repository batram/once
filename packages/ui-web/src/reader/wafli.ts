import createWafliModule from "./wafli-module.js"

export const WAFLI_VOICE_URI = "once-wafli-slt"

interface WafliAudio {
  samples: Int16Array
  sampleRate: number
  channels: number
}

interface WafliInstance {
  synthesize(text: string, options: {
    rate: number
    strategy: "sonic"
  }): WafliAudio
  dispose(): void
}

interface WafliModule {
  HEAP16: Int16Array
  _wafli_init(): number
  _wafli_synthesize(text: number, rate: number, strategy: number): number
  _wafli_samples(): number
  _wafli_sample_count(): number
  _wafli_sample_rate(): number
  _wafli_channel_count(): number
  _wafli_release(): void
  _wafli_shutdown(): void
  _free(pointer: number): void
  stringToNewUTF8(text: string): number
}

export interface WafliSpeechOptions {
  wasmUrl: string
}

export function wafliVoice(isDefault = false): SpeechSynthesisVoice {
  return {
    voiceURI: WAFLI_VOICE_URI,
    name: "Wafli SLT — offline",
    lang: "en-US",
    default: isDefault,
    localService: true
  } as SpeechSynthesisVoice
}

export async function createWafli(wasmUrl: string): Promise<WafliInstance> {
  const module = await createWafliModule({
    locateFile: (path: string) => path.endsWith(".wasm") ? wasmUrl : path
  }) as WafliModule
  if (!module._wafli_init()) throw new Error("Unable to initialize Wafli SLT")
  let disposed = false
  return {
    synthesize(text, { rate }) {
      if (disposed) throw new Error("Wafli has been disposed")
      const textPointer = module.stringToNewUTF8(text)
      try {
        // Strategy 1 is Sonic: synthesize at SLT's natural cadence, then use
        // pitch-preserving time compression. It stays clearer at reader rates.
        if (!module._wafli_synthesize(textPointer, rate, 1)) {
          throw new Error("Wafli synthesis failed")
        }
        const pointer = module._wafli_samples()
        const length = module._wafli_sample_count()
        const audio = {
          samples: module.HEAP16.slice(pointer >> 1, (pointer >> 1) + length),
          sampleRate: module._wafli_sample_rate(),
          channels: module._wafli_channel_count()
        }
        module._wafli_release()
        return audio
      } finally {
        module._free(textPointer)
      }
    },
    dispose() {
      if (disposed) return
      module._wafli_shutdown()
      disposed = true
    }
  }
}

export function toAudioBuffer(context: BaseAudioContext, audio: WafliAudio): AudioBuffer {
  const frames = audio.samples.length / audio.channels
  const buffer = context.createBuffer(audio.channels, frames, audio.sampleRate)
  for (let channel = 0; channel < audio.channels; channel += 1) {
    const output = buffer.getChannelData(channel)
    for (let frame = 0; frame < frames; frame += 1) {
      output[frame] = audio.samples[frame * audio.channels + channel] / 32768
    }
  }
  return buffer
}
