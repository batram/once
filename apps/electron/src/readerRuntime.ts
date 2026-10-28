import { installReaderTts } from "@once/ui-web/reader/readerTts"
import {
  emptyReaderTtsPreferences,
  normalizeReaderTtsPreferences,
  ReaderTtsPreferences
} from "@once/ui-web/reader/readerTtsPreferences"
import { installReaderAi } from "@once/ui-web/reader/readerAiControls"
import { ReaderAiRequest, ReaderAiResponse } from "@once/core"

interface ReaderTtsBridge {
  getPreferences(): Promise<unknown>
  setPreferences(preferences: ReaderTtsPreferences): void
  claim(): void
  release(): void
  onStop(handler: () => void): () => void
}

declare global {
  interface Window {
    onceReaderAi?: { send(request: ReaderAiRequest): void; listen(handler: (response: ReaderAiResponse) => void): () => void }
    onceReaderTts?: ReaderTtsBridge
  }
}

// Each reader document is an origin of its own, so the voice and speeds, and
// which reader is speaking, come from main's bridge; without one (a document
// shown outside a tab) the reader keeps them to itself.
async function installSpeech(): Promise<void> {
  const wafli = { wasmUrl: "once-reader://runtime/wafli-module.wasm" }
  const bridge = window.onceReaderTts
  if (!bridge) {
    installReaderTts({ wafli })
    return
  }
  let preferences = emptyReaderTtsPreferences()
  try {
    preferences = normalizeReaderTtsPreferences(await bridge.getPreferences())
  } catch (error) {
    console.warn("Reader speech settings unavailable", error)
  }
  installReaderTts({
    wafli,
    preferences,
    onPreferencesChange: (changed) => bridge.setPreferences(changed),
    claimOwnership: () => bridge.claim(),
    releaseOwnership: () => bridge.release(),
    subscribeToStop: (handler) => bridge.onStop(handler)
  })
}
void installSpeech()

if (window.onceReaderAi) installReaderAi((request, signal, progress) => new Promise((resolve, reject) => {
  const bridge = window.onceReaderAi
  if (!bridge) { reject(new Error("Reader AI unavailable")); return }
  const cleanup = () => { clearTimeout(timer); release(); signal?.removeEventListener("abort", abort) }
  const abort = () => { bridge.send({ ...request, action: "cancel" }); cleanup(); reject(new Error("Request cancelled")) }
  let timer = setTimeout(abort, 150000)
  const release = bridge.listen(response => { if (response.id !== request.id) return; if (response.progress) { clearTimeout(timer); timer = setTimeout(abort, 150000); progress?.(response.progress); return }
    cleanup(); if (response.error) reject(Object.assign(new Error(response.error), { code: response.code })); else resolve(response.value) })
  signal?.addEventListener("abort", abort, { once: true })
  if (signal?.aborted) { abort(); return }
  bridge.send(request)
}))
