import { installReaderTts } from "@once/ui-web/reader/readerTts"

installReaderTts({
  wafli: { wasmUrl: "once-reader://runtime/wafli-module.wasm" }
})

import { installReaderAi } from "@once/ui-web/reader/readerAiControls"
import { ReaderAiRequest, ReaderAiResponse } from "@once/core"
declare global { interface Window { onceReaderAi?: { send(request: ReaderAiRequest): void; listen(handler: (response: ReaderAiResponse) => void): () => void } } }
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
