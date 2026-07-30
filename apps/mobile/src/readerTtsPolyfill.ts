import {
  BridgedSpeechSynthesisUtterance,
  ReaderTtsAdapter,
  ReaderTtsAdapterTarget
} from "./ReaderTtsAdapter"

export interface ReaderTtsPolyfillTarget extends ReaderTtsAdapterTarget {
  speechSynthesis?: unknown
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

  Object.defineProperty(target, "speechSynthesis", {
    configurable: true,
    value: new ReaderTtsAdapter(target)
  })
  Object.defineProperty(target, "SpeechSynthesisUtterance", {
    configurable: true,
    value: BridgedSpeechSynthesisUtterance
  })
}
