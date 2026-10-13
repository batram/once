import { ipcRenderer } from "electron"
import { installImageTextAnchor } from "@once/ui-web/imageText/imageTextAnchor"
import { IMAGE_TEXT_IPC } from "./browser/imageTextIpc"

declare global { interface Window { __onceImageTextPush?: (payload: string) => void } }

// No contextBridge export: only main can issue commands to this frame's preload.
let installed = false
ipcRenderer.on(IMAGE_TEXT_IPC.command, (_event, request: { id: string; token: string; method: string; values: unknown[] }) => {
  void (async () => {
    if (!installed) {
      installImageTextAnchor()
      window.__onceImageTextPush = (payload: string) => ipcRenderer.send(IMAGE_TEXT_IPC.closed, payload)
      installed = true
    }
    const anchor = window.__onceImageTextAnchor
    if (!anchor) throw new Error("Image text host unavailable")
    let value: unknown
    switch (request.method) {
      case "start": value = anchor.start(request.token, ...(request.values as [string, number, number, string])); break
      case "stop": anchor.stop(request.token); break
      case "state": value = anchor.state(request.token); break
      case "locate": value = anchor.locate(...(request.values as [string, number, number])); break
      case "source": value = anchor.source(request.token); break
      case "message": anchor.message(request.token, request.values[0] as Parameters<typeof anchor.message>[1]); break
      case "reveal": value = anchor.reveal(request.token); break
      case "reveal-child": {
        const child = window.frames[Number(request.values[0])]
        const element = [...document.querySelectorAll("iframe,frame")].find(candidate => (candidate as HTMLIFrameElement).contentWindow === child)
        element?.scrollIntoView({ block: "nearest", inline: "nearest" })
        break
      }
      default: throw new Error("Unknown image text command")
    }
    ipcRenderer.send(IMAGE_TEXT_IPC.reply, { id: request.id, value })
  })().catch(() => ipcRenderer.send(IMAGE_TEXT_IPC.reply, { id: request.id, error: "Image text frame unavailable" }))
})
