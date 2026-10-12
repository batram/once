import { OnceClient } from "@once/app"
import { READER_AI_CHANNEL, readReaderAiRequest } from "@once/core"
import { executeReaderAi } from "@once/ui-web/reader/readerAiHost"
import { MobileReadingController } from "./readingController"

export function installReaderAiHost(client: OnceClient, reading: MobileReadingController): void {
  const active = new Map<MessageEventSource, Map<string, AbortController>>()
  window.addEventListener("message", event => {
    if (!event.source || !reading.runtimeReaderWindow(event.source) || event.data?.channel !== READER_AI_CHANNEL) return
    const source = event.source as Window
    try {
      const request = readReaderAiRequest(event.data)
      if (request.documentId !== reading.runtime.readerDocumentIdentity(source)) return
      const tab = reading.runtime.tabForReaderWindow(source)
      if (tab?.session.snapshot().currentUrl !== request.sourceUrl) return
      const requests = active.get(source) ?? new Map<string, AbortController>()
      active.set(source, requests)
      if (request.action === "cancel") { requests.get(request.id)?.abort(); return }
      if (requests.has(request.id) || requests.size >= 2) return
      const controller = new AbortController(); requests.set(request.id, controller)
      const post = (value: unknown) => { if (!controller.signal.aborted && reading.runtimeReaderWindow(source) && request.documentId === reading.runtime.readerDocumentIdentity(source)) source.postMessage({ channel: READER_AI_CHANNEL, id: request.id, ...value as object }, "*") }
      void executeReaderAi(client, request, controller.signal, progress => post({ progress }))
        .then(value => post({ value }), error => post({ error: error instanceof Error ? error.message : String(error), code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined }))
        .finally(() => { requests.delete(request.id); if (!requests.size) active.delete(source) })
    } catch { /* Ignore invalid messages from reader documents. */ }
  })
  reading.onReaderClosed(reader => {
    for (const [source, requests] of active) if (reader.isReaderWindow(source)) { for (const controller of requests.values()) controller.abort(); active.delete(source) }
  })
}
