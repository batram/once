import { startImageTextLayerView } from "@once/ui-web/imageText/imageTextView"
import type { ImageTextViewEvent, ImageTextViewMessage } from "@once/ui-web/imageText/imageTextTypes"

// The page of Android's image text overlay: a transparent system WebView the
// app lays over the long-pressed image (see ImageTextOverlay.java), so nothing
// of the selection enters the page. The app talks to it through a JavaScript
// interface one way and evaluated calls the other.

declare global {
  interface Window {
    onceImageTextNative?: { send(event: string): void }
    __onceImageTextMessage?: (message: string) => void
    __onceImageTextCopy?: () => string
  }
}

const view = startImageTextLayerView({
  send: (event: ImageTextViewEvent) => window.onceImageTextNative?.send(JSON.stringify(event)),
  onMessage: (handler) => {
    window.__onceImageTextMessage = (message) => handler(JSON.parse(message) as ImageTextViewMessage)
  }
})
window.__onceImageTextCopy = () => view.copyText()
window.onceImageTextNative?.send(JSON.stringify({ type: "ready" } satisfies ImageTextViewEvent))
