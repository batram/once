import {
  ElectronBridge,
  ElectronFetchRequest,
  ElectronFetchResponse
} from "./types"

export async function bridgeFetch(
  bridge: ElectronBridge,
  input: RequestInfo | URL,
  init?: RequestInit
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
  if (init?.signal && bridge.cancelFetch) serialized.requestId = crypto.randomUUID()

  if (request.method !== "GET" && request.method !== "HEAD") {
    serialized.body = await request.clone().arrayBuffer()
  }

  init?.signal?.throwIfAborted()
  const cancel = () => { if (serialized.requestId) void bridge.cancelFetch?.(serialized.requestId).catch(() => undefined) }
  init?.signal?.addEventListener("abort", cancel, { once: true })
  let response: ElectronFetchResponse
  try {
    response = await bridge.fetch(serialized)
    init?.signal?.throwIfAborted()
  } catch (error) { throw unwrapBridgeError(error) }
  finally { init?.signal?.removeEventListener("abort", cancel) }
  return new Response(response.body, {
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
