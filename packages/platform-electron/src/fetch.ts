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

  if (request.method !== "GET" && request.method !== "HEAD") {
    serialized.body = await request.clone().arrayBuffer()
  }

  const response: ElectronFetchResponse = await bridge.fetch(serialized).catch(
    (error: unknown) => {
      throw unwrapBridgeError(error)
    }
  )
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
