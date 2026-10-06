import { installReaderTts } from "@once/ui-web/reader/readerTts"
import { captureReaderPositionInPage, restoreReaderPositionInPage } from "@once/app/tabsync/pageScripts"
import {
  emptyReaderTtsPreferences,
  ReaderTtsPreferences
} from "@once/ui-web/reader/readerTtsPreferences"
import { installReaderTtsPolyfill } from "./readerTtsPolyfill"
import { installReaderFind } from "./readerFind"
import { installReaderLinkMenu, installReaderLinks } from "./readerLinks"
import { installReaderEdgeSwipe } from "./readerEdgeSwipe"
import {
  isReaderTtsEvent,
  READER_TTS_CHANNEL,
  READER_TTS_VERSION,
  ReaderTtsEvent,
  ReaderTtsRequestBody
} from "./readerTtsProtocol"

installReaderTtsPolyfill(window, { force: true })
installReaderFind(window)
installReaderLinks(window)
installReaderLinkMenu(window)
installReaderEdgeSwipe(window)
const sessionId = `ui-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
const controlListeners = new Set<(message: ReaderTtsEvent) => void>()
window.addEventListener("message", (event) => {
  if (
    event.source !== window.parent ||
    !isReaderTtsEvent(event.data) ||
    event.data.sessionId !== sessionId
  ) return
  controlListeners.forEach((listener) => listener(event.data))
})
const postToHost = (body: ReaderTtsRequestBody): void => {
  window.parent.postMessage({
    channel: READER_TTS_CHANNEL,
    version: READER_TTS_VERSION,
    sessionId,
    ...body
  }, "*")
}
// The sandboxed frame cannot keep storage, so the host holds the voice and
// speeds; an unanswered request falls back to defaults.
const storedPreferences = new Promise<ReaderTtsPreferences>((resolve) => {
  const timeout = window.setTimeout(() => finish(emptyReaderTtsPreferences()), 1000)
  const listener = (message: ReaderTtsEvent): void => {
    if (message.type === "preferences") finish(message.preferences)
  }
  const finish = (preferences: ReaderTtsPreferences): void => {
    window.clearTimeout(timeout)
    controlListeners.delete(listener)
    resolve(preferences)
  }
  controlListeners.add(listener)
  postToHost({ type: "preferences" })
})
// Mobile owns navigation and speech controls outside the sandboxed document.
// Hide the legacy reader header as a unit so its duplicate TTS controls and
// Original link do not consume article space.
document.querySelector<HTMLElement>(".toolbar")?.setAttribute("hidden", "")
void storedPreferences.then((preferences) => installReaderTts({
  preferences,
  onPreferencesChange(changed) {
    postToHost({ type: "save-preferences", preferences: changed })
  },
  onStateChange(state) {
    postToHost({ type: "ui-state", ...state })
  },
  subscribeToControl(handler) {
    const listener = (message: ReaderTtsEvent): void => {
      switch (message.type) {
        case "ui-play-toggle":
          handler({ type: "play-toggle" })
          break
        case "ui-stop":
          handler({ type: "stop" })
          break
        case "ui-prev":
          handler({ type: "prev" })
          break
        case "ui-next":
          handler({ type: "next" })
          break
        case "ui-set-rate":
          handler({ type: "set-rate", rate: message.rate })
          break
        case "ui-set-voice":
          handler({ type: "set-voice", voice: message.voice })
      }
    }
    controlListeners.add(listener)
    return () => controlListeners.delete(listener)
  }
}))

// The sandbox reports scroll only to its parent; retained frames keep their own
// scroll naturally, while a lazily restored document receives the saved offset.
let scrollReportPending = false
window.addEventListener("scroll", () => {
  if (scrollReportPending) return
  scrollReportPending = true
  window.setTimeout(() => {
    scrollReportPending = false
    // The block in view travels to other devices, whose screens lay the article out differently.
    window.parent.postMessage({ channel: "once-reader-scroll", type: "position", y: window.scrollY,
      position: captureReaderPositionInPage() }, "*")
  }, 150)
}, { passive: true })
window.addEventListener("message", event => {
  if (event.source !== window.parent || event.data?.channel !== "once-reader-scroll" || event.data.type !== "restore") return
  const position = event.data.position as { fraction?: unknown; anchor?: { index?: unknown; text?: unknown } | null } | undefined
  if (position && typeof position.fraction === "number") {
    restoreReaderPositionInPage(position.fraction, Number(position.anchor?.index ?? -1), String(position.anchor?.text ?? ""))
  } else if (Number.isFinite(event.data.y)) window.scrollTo(0, Math.max(0, event.data.y))
})
