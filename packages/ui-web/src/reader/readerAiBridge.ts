import { READER_AI_CHANNEL, ReaderAiResponse } from "@once/core"
import { ReaderAiSend } from "./readerAiControls"

const IDLE_MS = 150_000
export function readerAiMessageBridge(): ReaderAiSend {
  return (request, signal, progress) => new Promise((resolve, reject) => {
    const cleanup = () => { clearTimeout(timer); window.removeEventListener("message", listener); signal?.removeEventListener("abort", abort) }
    const listener = (event: MessageEvent) => {
      if (event.source !== window.parent || event.data?.channel !== READER_AI_CHANNEL || event.data.id !== request.id) return
      const response = event.data as ReaderAiResponse
      if (response.progress) { clearTimeout(timer); timer = setTimeout(abort, IDLE_MS); progress?.(response.progress); return }
      cleanup(); if (response.error) reject(Object.assign(new Error(response.error), { code: response.code })); else resolve(response.value)
    }
    const abort = () => { window.parent.postMessage({ channel: READER_AI_CHANNEL, ...request, action: "cancel" }, "*"); cleanup(); reject(new Error("Request cancelled or timed out")) }
    let timer = setTimeout(abort, IDLE_MS)
    window.addEventListener("message", listener)
    signal?.addEventListener("abort", abort, { once: true })
    if (signal?.aborted) { abort(); return }
    window.parent.postMessage({ channel: READER_AI_CHANNEL, ...request }, "*")
  })
}
interface ReaderPort { postMessage(value: unknown): void; disconnect(): void; onMessage: { addListener(handler: (message: ReaderAiResponse) => void): void }; onDisconnect: { addListener(handler: () => void): void } }
export function readerAiPortBridge(connect: () => ReaderPort | Promise<ReaderPort>): ReaderAiSend {
  return async (request, signal, progress) => {
    const port = await connect()
    return new Promise((resolve, reject) => {
      let settled = false
      const finish = (value?: unknown, error?: string, code?: string) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort); port.disconnect(); if (error) reject(Object.assign(new Error(error), { code })); else resolve(value) }
      const abort = () => { try { port.postMessage({ ...request, action: "cancel" }) } finally { finish(undefined, "Request cancelled or timed out") } }
      let timer = setTimeout(abort, IDLE_MS)
      port.onMessage.addListener(message => { if (message.id !== request.id) return; if (message.progress) { clearTimeout(timer); timer = setTimeout(abort, IDLE_MS); progress?.(message.progress) } else finish(message.value, message.error, message.code) })
      port.onDisconnect.addListener(() => finish(undefined, "Open the Once panel to use AI assistance"))
      signal?.addEventListener("abort", abort, { once: true })
      if (signal?.aborted) { abort(); return }
      port.postMessage(request)
    })
  }
}
