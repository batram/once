import {
  ElectronBridge,
  ElectronFetchRequest,
  ElectronFetchResponse
} from "./types"

export async function bridgeFetch(
  bridge: ElectronBridge,
  input: RequestInfo,
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

  const response: ElectronFetchResponse = await bridge.fetch(serialized)
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  })
}
