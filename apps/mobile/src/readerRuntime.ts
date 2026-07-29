import { installReaderTts } from "@once/ui-web/reader/readerTts"
import { installReaderTtsPolyfill } from "./readerTtsPolyfill"
import {
  isReaderTtsEvent,
  READER_TTS_CHANNEL,
  READER_TTS_VERSION,
  ReaderTtsEvent
} from "./readerTtsProtocol"

installReaderTtsPolyfill(window, { force: true })
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
// Mobile owns navigation and speech controls outside the sandboxed document.
// Hide the legacy reader header as a unit so its duplicate TTS controls and
// Original link do not consume article space.
document.querySelector<HTMLElement>(".toolbar")?.setAttribute("hidden", "")
installReaderTts({
  onStateChange(state) {
    window.parent.postMessage({
      channel: READER_TTS_CHANNEL,
      version: READER_TTS_VERSION,
      sessionId,
      type: "ui-state",
      ...state
    }, "*")
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
})
