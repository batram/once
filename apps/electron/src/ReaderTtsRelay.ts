import { app, ipcMain, IpcMainEvent, IpcMainInvokeEvent, WebContents } from "electron"
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import path from "node:path"
import { READER_TTS_IPC } from "./browser/readerTtsIpc"
import { sourceUrlFromReaderUrl } from "./browser/reader-url"

/** The reader's remembered speech settings, shaped as the reader keeps them (readerTtsPreferences.ts). */
export interface ReaderTtsPreferences {
  voice: string
  rates: Record<string, number>
}

const MAX_NAME = 200
const MAX_RATES = 100
const MIN_RATE = 0.5
const MAX_RATE = 6

/** Keeps only what the reader itself would accept: a voice name and finite speeds within its range. */
export function sanitizeReaderTtsPreferences(value: unknown): ReaderTtsPreferences {
  const result: ReaderTtsPreferences = { voice: "", rates: {} }
  const candidate = value && typeof value === "object" ? value as { voice?: unknown; rates?: unknown } : {}
  if (typeof candidate.voice === "string" && candidate.voice.length <= MAX_NAME) result.voice = candidate.voice
  if (candidate.rates && typeof candidate.rates === "object") {
    for (const [voice, rate] of Object.entries(candidate.rates as Record<string, unknown>)) {
      if (Object.keys(result.rates).length >= MAX_RATES) break
      if (voice.length <= MAX_NAME && typeof rate === "number" && Number.isFinite(rate) && rate >= MIN_RATE && rate <= MAX_RATE) {
        result.rates[voice] = rate
      }
    }
  }
  return result
}

/** The device's reader speech settings: one JSON file in the profile. */
export class ReaderTtsStore {
  constructor(private readonly file: string) {}

  load(): ReaderTtsPreferences {
    try {
      return existsSync(this.file)
        ? sanitizeReaderTtsPreferences(JSON.parse(readFileSync(this.file, "utf8")))
        : sanitizeReaderTtsPreferences(null)
    } catch {
      return sanitizeReaderTtsPreferences(null)
    }
  }

  save(preferences: ReaderTtsPreferences): void {
    mkdirSync(path.dirname(this.file), { recursive: true })
    writeFileSync(`${this.file}.tmp`, JSON.stringify(preferences), "utf8")
    renameSync(`${this.file}.tmp`, this.file)
  }
}

/** What the relay needs of a reader tab. */
export interface ReaderSpeaker {
  isDestroyed(): boolean
  send(channel: string): void
  once(event: "destroyed", listener: () => void): unknown
}

/**
 * Reader documents each live on an origin of their own, so what they used
 * to share through one origin, the chosen voice and speed and which of them
 * is reading aloud, goes through main instead: the settings in one profile
 * file, and one reader at a time, the previous one told to stop.
 */
export class ReaderTtsRelay {
  private owner: ReaderSpeaker | null = null
  private readonly watched = new WeakSet<ReaderSpeaker>()

  constructor(private readonly store: ReaderTtsStore) {}

  preferences(): ReaderTtsPreferences {
    return this.store.load()
  }

  remember(value: unknown): void {
    this.store.save(sanitizeReaderTtsPreferences(value))
  }

  claim(speaker: ReaderSpeaker): void {
    const previous = this.owner
    this.owner = speaker
    if (!this.watched.has(speaker)) {
      this.watched.add(speaker)
      speaker.once("destroyed", () => { if (this.owner === speaker) this.owner = null })
    }
    if (previous && previous !== speaker && !previous.isDestroyed()) previous.send(READER_TTS_IPC.stop)
  }

  release(speaker: ReaderSpeaker): void {
    if (this.owner === speaker) this.owner = null
  }
}

/** Only a reader document's own top frame may speak for it. */
function readerDocument(event: IpcMainEvent | IpcMainInvokeEvent): WebContents | null {
  if (event.senderFrame !== event.sender.mainFrame || !sourceUrlFromReaderUrl(event.sender.getURL())) return null
  return event.sender
}

export function registerReaderTtsRelay(
  file = path.join(app.getPath("userData"), "reader-tts.json")
): ReaderTtsRelay {
  const relay = new ReaderTtsRelay(new ReaderTtsStore(file))
  ipcMain.handle(READER_TTS_IPC.get, (event) => {
    if (!readerDocument(event)) throw new Error("Untrusted reader sender")
    return relay.preferences()
  })
  ipcMain.on(READER_TTS_IPC.set, (event, value: unknown) => {
    if (readerDocument(event)) relay.remember(value)
  })
  ipcMain.on(READER_TTS_IPC.claim, (event) => {
    const reader = readerDocument(event)
    if (reader) relay.claim(reader)
  })
  ipcMain.on(READER_TTS_IPC.release, (event) => {
    const reader = readerDocument(event)
    if (reader) relay.release(reader)
  })
  return relay
}
