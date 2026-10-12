import { OnceClient } from "@once/app"
import { ElectronBridge } from "@once/platform-electron/bridge"
import { executeReaderAi } from "@once/ui-web/reader/readerAiHost"

export function installReaderAiHost(client: OnceClient, bridge: ElectronBridge): void {
  const controllers = new Map<string, AbortController>()
  bridge.readerAi.onRequest((key, request) => {
    if (request.action === "cancel") { controllers.get(key)?.abort(); controllers.delete(key); return }
    if (controllers.has(key)) return
    const controller = new AbortController(); controllers.set(key, controller)
    void executeReaderAi(client, request, controller.signal, progress => bridge.readerAi.reply(key, { id: request.id, progress }))
      .then(value => { if (!controller.signal.aborted) bridge.readerAi.reply(key, { id: request.id, value }) }, error => { if (!controller.signal.aborted) bridge.readerAi.reply(key, { id: request.id, error: error instanceof Error ? error.message : String(error), code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined }) })
      .finally(() => controllers.delete(key))
  })
}
