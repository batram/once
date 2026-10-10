import { Capacitor } from "@capacitor/core"
import { MAX_DOCUMENT_BYTES } from "@once/app"
import { hasNullBody, isCrossOriginHttp, nativeFetch } from "./nativeFetch"

export interface DocumentDownloadPlugin {
  fetchDocument(options: {
    url: string
    maxBytes: number
    credentials: "include" | "omit"
    headers: Record<string, string>
  }): Promise<{ status: number; url?: string; headers?: Record<string, string>; base64?: string }>
}

/**
 * A fetch for documents handed to a decoder. Cross-origin GETs go through the
 * app's own native download, which stops reading at `maxBytes` as bytes
 * arrive; the generic HTTP plugin buffers a whole response first and only then
 * hands it over, so a misreported or absent Content-Length could fill memory
 * before retrieval's own cap applied. Everything else keeps nativeFetch's
 * behaviour, including cookies only with credentials: "include".
 */
export function createDocumentFetch(plugin: DocumentDownloadPlugin, maxBytes = MAX_DOCUMENT_BYTES): typeof fetch {
  return async (input, init) => {
    const request = new Request(input, init)
    if (!Capacitor.isNativePlatform() || request.method !== "GET" || !isCrossOriginHttp(request.url)) {
      return nativeFetch(input, init)
    }
    request.signal.throwIfAborted()
    const result = await plugin.fetchDocument({
      url: request.url,
      maxBytes,
      credentials: request.credentials === "include" ? "include" : "omit",
      headers: Object.fromEntries(request.headers)
    })
    request.signal.throwIfAborted()
    const body = hasNullBody(result.status) || !result.base64 ? null : decodeBase64(result.base64)
    const response = new Response(body, { status: result.status, headers: result.headers ?? {} })
    Object.defineProperty(response, "url", { value: result.url || request.url })
    return response
  }
}

function decodeBase64(encoded: string): Uint8Array<ArrayBuffer> {
  const binary = atob(encoded)
  const bytes = new Uint8Array(new ArrayBuffer(binary.length))
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  return bytes
}
