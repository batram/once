// The reader's remembered speech settings: the last chosen voice and a speed
// per voice, since voices speak at very different natural paces. The default
// voice is keyed "", and its speed also applies to voices never adjusted.

export interface ReaderTtsPreferences {
  voice: string
  rates: Record<string, number>
}

const READER_TTS_MIN_RATE = 0.5
const READER_TTS_MAX_RATE = 6

export function isReaderTtsRate(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) &&
    value >= READER_TTS_MIN_RATE && value <= READER_TTS_MAX_RATE
}

export function emptyReaderTtsPreferences(): ReaderTtsPreferences {
  return { voice: "", rates: {} }
}

/**
 * Accepts stored preferences, or a speed saved before speeds were per voice
 * (it becomes the default voice's speed); anything invalid is dropped.
 */
export function normalizeReaderTtsPreferences(
  value: unknown,
  legacyRate?: unknown
): ReaderTtsPreferences {
  const preferences = emptyReaderTtsPreferences()
  const candidate = value && typeof value === "object"
    ? value as { voice?: unknown; rates?: unknown }
    : {}
  if (typeof candidate.voice === "string") preferences.voice = candidate.voice
  if (candidate.rates && typeof candidate.rates === "object") {
    for (const [voice, rate] of Object.entries(candidate.rates)) {
      if (isReaderTtsRate(rate)) preferences.rates[voice] = rate
    }
  }
  const legacy = Number(legacyRate)
  if (!("" in preferences.rates) && legacyRate != null && isReaderTtsRate(legacy)) {
    preferences.rates[""] = legacy
  }
  return preferences
}

export function readerTtsRateForVoice(
  preferences: ReaderTtsPreferences,
  voice: string
): number {
  return preferences.rates[voice] ?? preferences.rates[""] ?? 1
}
