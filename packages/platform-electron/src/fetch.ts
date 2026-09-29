import {
  ElectronBridge,
  ElectronFetchChunk,
  ElectronFetchRequest,
  ElectronFetchResponse
} from "./types"

/**
 * Streamed bodies arrive as events for every request at once; each request
 * takes its own from here. A piece may arrive before the reply with its
 * head, so a request listens from before it is sent.
 */
const bodyListeners = new Map<string, (chunk: ElectronFetchChunk) => void>()
let unsubscribe: (() => void) | null = null

function listen(bridge: ElectronBridge, requestId: string, handler: (chunk: ElectronFetchChunk) => void): () => void {
  unsubscribe ??= bridge.onFetchChunk?.(chunk => bodyListeners.get(chunk.requestId)?.(chunk)) ?? null
  bodyListeners.set(requestId, handler)
  return () => {
    bodyListeners.delete(requestId)
    if (bodyListeners.size === 0) { unsubscribe?.(); unsubscribe = null }
  }
}

/** A body that arrives in pieces: the head resolves first, as a browser fetch's does. */
function streamedBody(bridge: ElectronBridge, requestId: string): { body: ReadableStream<Uint8Array>; stop(): void } {
  // `start` runs inside the constructor, so the controller exists before any piece can arrive.
  let controller!: ReadableStreamDefaultController<Uint8Array>
  const body = new ReadableStream<Uint8Array>({
    start(started) { controller = started },
    cancel() { stop(); void bridge.cancelFetch?.(requestId).catch(() => undefined) }
  })
  const stop = listen(bridge, requestId, chunk => {
    if ("chunk" in chunk) { controller.enqueue(chunk.chunk); return }
    stop()
    if ("error" in chunk) controller.error(new Error(chunk.error))
    else controller.close()
  })
  return { body, stop }
}

/** `bridgeFetch` whose body streams from main as it arrives; plain `bridgeFetch` where the bridge cannot. */
export function bridgeStreamingFetch(bridge: ElectronBridge, input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return bridgeFetch(bridge, input, init, !!bridge.onFetchChunk && !!bridge.cancelFetch)
}

export async function bridgeFetch(
  bridge: ElectronBridge,
  input: RequestInfo | URL,
  init?: RequestInit,
  stream = false
): Promise<Response> {
  const request = new Request(input, init)
  const serialized: ElectronFetchRequest = {
    url: request.url,
    method: request.method,
    headers: Array.from(request.headers.entries())
  }
  // Only an explicit ask travels: the main process decides what the default
  // is, and a request built without the option should not change that.
  if (init?.credentials === "include") serialized.credentials = "include"
  if (init?.redirect === "error") serialized.redirect = "error"
  if ((init?.signal || stream) && bridge.cancelFetch) serialized.requestId = crypto.randomUUID()
  if (stream) serialized.stream = true

  if (request.method !== "GET" && request.method !== "HEAD") {
    serialized.body = await request.clone().arrayBuffer()
  }

  init?.signal?.throwIfAborted()
  const cancel = () => { if (serialized.requestId) void bridge.cancelFetch?.(serialized.requestId).catch(() => undefined) }
  init?.signal?.addEventListener("abort", cancel, { once: true })
  const streamed = stream && serialized.requestId ? streamedBody(bridge, serialized.requestId) : null
  let response: ElectronFetchResponse
  try {
    response = await bridge.fetch(serialized)
    init?.signal?.throwIfAborted()
  } catch (error) {
    streamed?.stop()
    init?.signal?.removeEventListener("abort", cancel)
    throw unwrapBridgeError(error)
  }
  // A streamed body can still be cancelled until it ends.
  if (!streamed) init?.signal?.removeEventListener("abort", cancel)
  return new Response(streamed?.body ?? response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}

// ipcRenderer.invoke rejections arrive as
// "Error invoking remote method '<channel>': <Name>: <message>".
function unwrapBridgeError(error: unknown): unknown {
  if (!(error instanceof Error)) return error
  const match = /^Error invoking remote method '[^']*': (?:[A-Za-z]*Error: )?(.*)$/s.exec(
    error.message
  )
  if (match?.[1]) error.message = match[1]
  return error
}
