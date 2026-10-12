import { OnceClient } from "@once/app"
import { readReaderAiRequest } from "@once/core"
import { executeReaderAi } from "@once/ui-web/reader/readerAiHost"
import { isExtensionPageSender, isTabContentSender } from "./messageSender"

export function installReaderAiHost(client: OnceClient, browserApi: typeof browser): void {
  const owner = crypto.randomUUID()
  const registration = browserApi.runtime.connect({ name: "once-reader-ai-host" })
  void browserApi.windows.getCurrent().then(window => registration.postMessage({ owner, windowId: window.id }))
  const seen = new Set<string>()
  browserApi.runtime.onConnect.addListener(port => {
    if (port.name !== `once-reader-ai:${owner}` || !port.sender || (!isExtensionPageSender(browserApi, port.sender, "reader") && !isTabContentSender(port.sender))) return
    const sender = port.sender
    const controller = new AbortController()
    let started = false
    port.onDisconnect.addListener(() => controller.abort())
    port.onMessage.addListener(async raw => {
      let id = ""
      try {
        const request = readReaderAiRequest(raw); id = request.id
        if (request.action === "cancel") { controller.abort(); return }
        const identity = `${sender.tab?.id}:${sender.frameId}:${request.documentId}:${request.id}`
        if (seen.has(identity)) throw new Error("Reader AI request was already handled")
        if (seen.size >= 2000) seen.clear()
        seen.add(identity)
        if (started) throw new Error("One reader AI operation per connection")
        started = true
        if (isTabContentSender(sender) && new URL(request.sourceUrl).href !== new URL(sender.url ?? "").href) throw new Error("Reader source does not match the sending page")
        if (isExtensionPageSender(browserApi, sender, "reader")) {
          const current = new URL(sender.url ?? "")
          const bound = current.searchParams.get("sourceUrl")
          if (!bound || bound !== request.sourceUrl) throw new Error("Reader source does not match this document")
        }
        const value = await executeReaderAi(client, request, controller.signal, progress => port.postMessage({ id, progress }))
        if (!controller.signal.aborted) port.postMessage({ id, value })
      } catch (error) { if (!controller.signal.aborted) port.postMessage({ id, error: error instanceof Error ? error.message : String(error), code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined }) }
    })
  })
}
