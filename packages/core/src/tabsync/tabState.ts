/**
 * Special state a tab carries between devices: where a video was, how far
 * an article was read. Each kind has a provider id and a version; records
 * of an unknown id or a newer version are carried along untouched.
 */
export const MEDIA_STATE = { id: "media", version: 1 } as const
export const READER_STATE = { id: "reader.scroll", version: 1 } as const

export interface MediaState {
  currentTime: number
  duration: number
  paused: boolean
  rate: number
}

/**
 * How far an article was read: the first visible block (its index among
 * the article's blocks and the start of its text) and, as a fallback for
 * a page laid out differently, the fraction of the page above it.
 */
export interface ReaderPosition {
  fraction: number
  anchor: { index: number; text: string } | null
}

const finite = (value: unknown, min = 0): value is number => typeof value === "number" && Number.isFinite(value) && value >= min

export function readMediaState(value: unknown): MediaState | null {
  const record = value as Partial<MediaState> | null
  if (!record || !finite(record.currentTime) || !finite(record.duration) || !finite(record.rate) || record.rate === 0) return null
  return {
    currentTime: record.currentTime, duration: record.duration,
    paused: record.paused !== false, rate: record.rate
  }
}

export function readReaderPosition(value: unknown): ReaderPosition | null {
  const record = value as Partial<ReaderPosition> | null
  if (!record || !finite(record.fraction) || record.fraction > 1) return null
  const anchor = record.anchor as ReaderPosition["anchor"] | undefined
  return {
    fraction: record.fraction,
    anchor: anchor && Number.isSafeInteger(anchor.index) && anchor.index >= 0 && typeof anchor.text === "string"
      ? { index: anchor.index, text: anchor.text.slice(0, 64) } : null
  }
}

const YOUTUBE_HOSTS = /^(?:www\.|m\.|music\.)?(?:youtube\.com|youtube-nocookie\.com)$/

/** Whether a URL plays a YouTube video that a start time can be given to. */
export function isYouTubeVideo(url: string): boolean {
  try {
    const parsed = new URL(url)
    if (parsed.hostname === "youtu.be") return parsed.pathname.length > 1
    return YOUTUBE_HOSTS.test(parsed.hostname) &&
      (parsed.pathname === "/watch" || /^\/(?:embed|shorts|live)\//.test(parsed.pathname))
  } catch {
    return false
  }
}

/**
 * The video URL starting where it was left. YouTube honours `t` before any
 * script can run, so this works even where a page cannot be scripted.
 */
export function withYouTubeStart(url: string, seconds: number): string {
  if (!isYouTubeVideo(url) || !finite(seconds)) return url
  const parsed = new URL(url)
  const whole = Math.floor(seconds)
  if (whole < 1) parsed.searchParams.delete("t")
  else parsed.searchParams.set("t", `${whole}s`)
  parsed.searchParams.delete("start")
  return parsed.href
}

export function formatPlaybackTime(seconds: number): string {
  const whole = Math.max(0, Math.floor(seconds))
  const hours = Math.floor(whole / 3600)
  const minutes = Math.floor(whole / 60) % 60
  const rest = String(whole % 60).padStart(2, "0")
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${rest}` : `${minutes}:${rest}`
}

/** A short line for a tab's state, e.g. "▶ 12:34 / 45:10" or "Read 40 %". */
export function describeTabState(state: Record<string, { data: unknown }> | undefined): string {
  const media = readMediaState(state?.[MEDIA_STATE.id]?.data)
  if (media) {
    const total = media.duration > 0 ? ` / ${formatPlaybackTime(media.duration)}` : ""
    return `${media.paused ? "⏸" : "▶"} ${formatPlaybackTime(media.currentTime)}${total}`
  }
  const reader = readReaderPosition(state?.[READER_STATE.id]?.data)
  return reader ? `Read ${Math.round(reader.fraction * 100)} %` : ""
}
