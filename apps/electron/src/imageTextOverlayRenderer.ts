import { startImageTextWordsView } from "@once/ui-web/imageText/imageTextView"
import type { ImageTextViewBridge, ImageTextViewEvent, ImageTextViewMessage } from "@once/ui-web/imageText/imageTextTypes"

// The image text selection's words frame, served as once-image-text://<id>/
// (browser/ImageTextProtocol.ts) and anchored to the image by the app's host
// in the page (imageTextAnchor.ts). The host hands it a port of its own, with
// the token only the two of them know (the app writes it into this page, in
// no URL): the page cannot post into it.
function hostBridge(): ImageTextViewBridge {
  const token = document.querySelector<HTMLMetaElement>("meta[name=once-image-text-token]")?.content || null
  let port: MessagePort | null = null
  let handler: (message: ImageTextViewMessage) => void = () => undefined
  const queued: ImageTextViewEvent[] = []
  addEventListener("message", (event: MessageEvent<{ onceImageText?: string }>) => {
    if (port || !token || event.source !== parent || event.data?.onceImageText !== token || !event.ports[0]) return
    port = event.ports[0]
    port.onmessage = (message: MessageEvent<ImageTextViewMessage>) => handler(message.data)
    for (const queuedEvent of queued.splice(0)) port.postMessage(queuedEvent)
  })
  return {
    send: (event) => { if (port) port.postMessage(event); else queued.push(event) },
    onMessage: (next) => { handler = next }
  }
}

const bridge = hostBridge()
startImageTextWordsView(bridge)
// Running: the host otherwise takes the frame for one a sandboxed page keeps from running (see imageTextAnchor.ts).
bridge.send({ type: "ready" })
