// DevTools `Fetch` events, forwarded by Java, fed through the shared
// `WebRequestRouter` in Electron's order (declarative rules, blocking
// listeners, the held `onResponseStarted` of documents, header rules), and
// answered with the `Fetch.*` commands Java issues: `failRequest`,
// `fulfillRequest`, `continueRequest`, `continueResponse`. Extension-page
// URLs are served here from the package; documents get the per-document
// script nonce the content worlds stamp on their scriptlets; responses an
// extension page reads from a permitted host get the CORS grant Chromium
// still checks on a fulfilled response. `Network.*` events complete the
// notification stages.

import {
  HttpHeader,
  OwnPageRequests,
  WebRequestDetailsInput,
  WebRequestRouter,
  headersFromWebExt,
  headersToWebExt,
  isOwnPage,
  permittedHosts,
  serveExtensionRequest,
  sha256Hex
} from "@once/webext-runtime"
import { JavaChannel } from "./javaChannel"
import { TargetFrames } from "./liteFrames"
import { LiteExtensionHost } from "./liteHosts"
import { CdpCommandParams, electronResourceType, extensionUrlFromPageUrl, pageHostOf, pageOrigin, TargetKind } from "./protocol"

export interface RequestTarget {
  kind: TargetKind
  tabId: number
  /** For an extension page target: the extension it shows. */
  pageHost?: string
  frames: TargetFrames
}

export interface FetchRequestPaused {
  requestId: string
  request: { url: string; method: string; headers: Record<string, string>; postData?: string; hasPostData?: boolean }
  frameId: string
  resourceType: string
  responseErrorReason?: string
  responseStatusCode?: number
  responseStatusText?: string
  responseHeaders?: HttpHeader[]
  networkId?: string
  redirectedRequestId?: string
}

/** What a response-body rewrite (`filterResponseData`) is given and answers. */
export interface ResponseBodyFilter {
  /** Whether this request's body should be fetched and offered; decided at the response stage. */
  wants(requestId: string): boolean
  /** The whole body; answers the replacement, or null to deliver the original. */
  rewrite(requestId: string, body: Uint8Array, headers: HttpHeader[]): Promise<Uint8Array | null>
}

interface RequestRecord {
  input: WebRequestDetailsInput
  targetId: string
}

export interface LiteWebRequestOptions {
  channel: JavaChannel
  router: WebRequestRouter
  ownPages: OwnPageRequests
  hosts(): Iterable<LiteExtensionHost>
  target(targetId: string): RequestTarget | undefined
  /** The secret the document nonces derive from; the world bootstraps hold the same one. */
  token(): string
  /** Resolves when documents may proceed; the Violentmonkey hand-off holds them. */
  documentsReleased(): Promise<void>
}

/** The nonce the broker adds to a document's `script-src` and the world recomputes from `location`. */
export function documentNonce(token: string, documentUrl: string): string {
  let canonical = documentUrl
  try {
    const url = new URL(documentUrl)
    url.hash = ""
    canonical = url.href
  } catch { /* an opaque URL is used as is */ }
  return sha256Hex(`${token}|${canonical}`).slice(0, 32)
}

const INLINE_TOKENS = /'(?:unsafe-inline|nonce-[^']*|sha(?:256|384|512)-[^']*)'/

/** `script-src` (or the `default-src` it falls back to) with the nonce allowed. */
export function addNonceToPolicy(policy: string, nonce: string): string {
  const directives = policy.split(";").map((part) => part.trim()).filter(Boolean)
  const names = directives.map((directive) => directive.split(/\s+/)[0].toLowerCase())
  let targets = directives.map((_d, index) => index).filter((index) => names[index] === "script-src" || names[index] === "script-src-elem")
  if (targets.length === 0) targets = directives.map((_d, index) => index).filter((index) => names[index] === "default-src")
  if (targets.length === 0) return policy
  for (const index of targets) {
    const directive = directives[index]
    // 'unsafe-inline' already lets inline scripts run and a nonce would switch it off.
    if (/'unsafe-inline'/.test(directive) && !/'(?:nonce|sha256|sha384|sha512)-/.test(directive)) continue
    if (!INLINE_TOKENS.test(directive) && /'none'/.test(directive)) {
      directives[index] = `${directive.replace(/'none'/, "").trim()} 'nonce-${nonce}'`
      continue
    }
    directives[index] = `${directive} 'nonce-${nonce}'`
  }
  return directives.join("; ")
}

export function withDocumentNonce(headers: HttpHeader[], nonce: string): HttpHeader[] {
  return headers.map((header) => header.name.toLowerCase() === "content-security-policy"
    ? { name: header.name, value: addNonceToPolicy(header.value, nonce) }
    : header)
}

/** Electron's grant: permissive CORS for a permitted host, as Firefox lets extension pages read. */
export function withCorsGrant(headers: HttpHeader[], origin: string): HttpHeader[] {
  return [
    ...headers.filter((header) => !header.name.toLowerCase().startsWith("access-control-")),
    { name: "Access-Control-Allow-Origin", value: origin },
    { name: "Access-Control-Allow-Credentials", value: "true" },
    { name: "Access-Control-Allow-Headers", value: "*" },
    { name: "Access-Control-Allow-Methods", value: "*" },
    { name: "Access-Control-Expose-Headers", value: "*" }
  ]
}

function toBase64(bytes: Uint8Array): string {
  let binary = ""
  for (let offset = 0; offset < bytes.length; offset += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
  }
  return btoa(binary)
}

function fromBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

export class LiteWebRequest {
  private readonly records = new Map<string, RequestRecord>()
  private readonly ids = new Map<string, number>()
  private readonly filters: ResponseBodyFilter[] = []
  private nextId = 1

  constructor(private readonly options: LiteWebRequestOptions) {}

  addBodyFilter(filter: ResponseBodyFilter): void {
    this.filters.push(filter)
  }

  /** `Fetch.requestPaused` from a target. */
  async requestPaused(targetId: string, event: FetchRequestPaused): Promise<void> {
    const target = this.options.target(targetId)
    if (!target) {
      await this.cdp(targetId, "Fetch.continueRequest", { requestId: event.requestId })
      return
    }
    try {
      if (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined) {
        await this.responseStage(targetId, target, event)
      } else {
        await this.requestStage(targetId, target, event)
      }
    } catch (error) {
      this.options.channel.log("error", `Request ${event.request.url} failed in the broker: ${String(error)}`)
      await this.cdp(targetId, "Fetch.continueRequest", { requestId: event.requestId }).catch(() => undefined)
    }
  }

  /** `Network.requestWillBeSent` with a `redirectResponse`, `loadingFinished`, `loadingFailed`. */
  networkEvent(targetId: string, method: string, params: Record<string, unknown>): void {
    const networkId = String(params.requestId ?? "")
    const record = this.records.get(`${targetId}:${networkId}`)
    if (!record) return
    if (method === "Network.requestWillBeSent") {
      const redirect = params.redirectResponse as { status?: number; statusText?: string; headers?: Record<string, string> } | undefined
      if (!redirect) return
      this.options.router.beforeRedirect({
        ...record.input,
        statusCode: redirect.status,
        statusLine: `HTTP/1.1 ${redirect.status ?? 0} ${redirect.statusText ?? ""}`.trim(),
        responseHeaders: redirect.headers ?? {},
        redirectUrl: String((params.request as { url?: string } | undefined)?.url ?? "")
      })
      record.input = { ...record.input, url: String((params.request as { url?: string } | undefined)?.url ?? record.input.url) }
    } else if (method === "Network.loadingFinished") {
      this.options.router.completed({ ...record.input, statusCode: record.input.statusCode })
      this.forget(targetId, networkId)
    } else if (method === "Network.loadingFailed") {
      this.options.router.errorOccurred({
        ...record.input,
        error: String(params.errorText ?? (params.canceled ? "NS_BINDING_ABORTED" : "NS_ERROR_FAILURE"))
      })
      this.forget(targetId, networkId)
    }
  }

  forgetTarget(targetId: string): void {
    for (const key of [...this.records.keys()]) if (key.startsWith(`${targetId}:`)) this.records.delete(key)
  }

  private forget(targetId: string, networkId: string): void {
    this.records.delete(`${targetId}:${networkId}`)
    this.ids.delete(`${targetId}:${networkId}`)
  }

  private cdp(targetId: string, method: string, params: unknown): Promise<unknown> {
    return this.options.channel.request("cdp.command", { targetId, method, params } satisfies CdpCommandParams)
  }

  private input(targetId: string, target: RequestTarget, event: FetchRequestPaused): WebRequestDetailsInput {
    const key = `${targetId}:${event.networkId ?? event.requestId}`
    let id = this.ids.get(key)
    if (id === undefined) {
      id = this.nextId++
      this.ids.set(key, id)
    }
    const existing = this.records.get(key)
    const facts = target.frames.facts(event.frameId)
    const input: WebRequestDetailsInput = {
      id,
      url: event.request.url,
      method: event.request.method,
      resourceType: electronResourceType(event.resourceType, target.frames.isTop(event.frameId)),
      referrer: event.request.headers.Referer ?? event.request.headers.referer ?? "",
      timestamp: existing?.input.timestamp ?? Date.now(),
      tabId: target.tabId,
      frame: facts
    }
    this.records.set(key, { input, targetId })
    return input
  }

  private hostFor(extensionHost: string): LiteExtensionHost | undefined {
    for (const host of this.options.hosts()) if (host.extension.host === extensionHost) return host
    return undefined
  }

  private async requestStage(targetId: string, target: RequestTarget, event: FetchRequestPaused): Promise<void> {
    const input = this.input(targetId, target, event)
    const extensionHost = pageHostOf(event.request.url)
    if (extensionHost !== null) {
      await this.serveExtensionUrl(targetId, target, event, input, extensionHost)
      return
    }
    if (input.resourceType === "mainFrame" && target.kind === "tab") await this.options.documentsReleased()
    const decision = await this.options.router.beforeRequest(input)
    if (decision.cancel) {
      await this.cdp(targetId, "Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" })
      this.options.router.errorOccurred({ ...input, error: "NS_ERROR_ABORT" })
      this.forget(targetId, event.networkId ?? event.requestId)
      return
    }
    if (decision.redirectUrl) {
      const location = pageHostOf(decision.redirectUrl) ? pageUrlOf(decision.redirectUrl) : decision.redirectUrl
      await this.cdp(targetId, "Fetch.fulfillRequest", {
        requestId: event.requestId, responseCode: 307, responseHeaders: [{ name: "Location", value: location }]
      })
      return
    }
    const headers = await this.options.router.beforeSendHeaders({ ...input, requestHeaders: event.request.headers })
    if (headers.cancel) {
      await this.cdp(targetId, "Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" })
      this.forget(targetId, event.networkId ?? event.requestId)
      return
    }
    const sent = headers.requestHeaders ?? headersToWebExt(event.request.headers)
    await this.cdp(targetId, "Fetch.continueRequest", {
      requestId: event.requestId,
      ...(headers.requestHeaders ? { headers: headers.requestHeaders } : {})
    })
    this.options.router.sendHeaders({ ...input, requestHeaders: headersFromWebExt(sent) })
  }

  /** An extension's own URL: served from the package, as the protocol handler would. */
  private async serveExtensionUrl(
    targetId: string,
    target: RequestTarget,
    event: FetchRequestPaused,
    input: WebRequestDetailsInput,
    extensionHost: string
  ): Promise<void> {
    const url = extensionUrlFromPageUrl(event.request.url)
    const host = this.hostFor(extensionHost)
    // The router sees it first so `requestFrom` can grant an own-page frame's loads.
    const decision = host ? await this.options.router.beforeRequest({ ...input, url }) : {}
    if (!host || decision.cancel) {
      await this.cdp(targetId, "Fetch.fulfillRequest", { requestId: event.requestId, responseCode: 404, responseHeaders: [] })
      return
    }
    const fromOwnPage = target.kind === "page" && target.pageHost === extensionHost
    const response = await serveExtensionRequest(url, (candidate) => this.hostFor(candidate)?.extension, {
      webAccessibleOnly: !fromOwnPage,
      ownPages: this.options.ownPages
    })
    const body = new Uint8Array(await response.arrayBuffer())
    const headers: HttpHeader[] = [...response.headers.entries()].map(([name, value]) => ({ name, value }))
    if (!fromOwnPage) headers.push({ name: "Access-Control-Allow-Origin", value: "*" })
    await this.cdp(targetId, "Fetch.fulfillRequest", {
      requestId: event.requestId, responseCode: response.status, responseHeaders: headers, body: toBase64(body)
    })
    this.forget(targetId, event.networkId ?? event.requestId)
  }

  private async responseStage(targetId: string, target: RequestTarget, event: FetchRequestPaused): Promise<void> {
    const input = this.input(targetId, target, event)
    const networkId = event.networkId ?? event.requestId
    if (event.responseErrorReason !== undefined) {
      await this.cdp(targetId, "Fetch.continueRequest", { requestId: event.requestId })
      return
    }
    const statusCode = event.responseStatusCode ?? 0
    const statusLine = `HTTP/1.1 ${statusCode} ${event.responseStatusText ?? ""}`.trim()
    const responseHeaders = headersFromWebExt(event.responseHeaders ?? [])
    const detailed = { ...input, statusCode, statusLine, responseHeaders }
    const record = this.records.get(`${targetId}:${networkId}`)
    if (record) record.input = detailed
    if (statusCode >= 300 && statusCode < 400 && (event.responseHeaders ?? []).some((header) => header.name.toLowerCase() === "location")) {
      // `Network.requestWillBeSent` reports the redirect with its new URL.
      await this.cdp(targetId, "Fetch.continueResponse", { requestId: event.requestId })
      return
    }
    const decision = await this.options.router.headersReceived(detailed)
    if (decision.cancel) {
      await this.cdp(targetId, "Fetch.failRequest", { requestId: event.requestId, errorReason: "BlockedByClient" })
      this.forget(targetId, networkId)
      return
    }
    let headers = decision.responseHeaders ?? event.responseHeaders ?? []
    if (input.resourceType === "mainFrame" || input.resourceType === "subFrame") {
      headers = withDocumentNonce(headers, documentNonce(this.options.token(), event.request.url))
    }
    if (target.kind === "page" && target.pageHost && /^https?:/.test(event.request.url)) {
      const host = this.hostFor(target.pageHost)
      if (host && permittedHosts(host.extension).matches(event.request.url)) {
        headers = withCorsGrant(headers, pageOrigin(target.pageHost))
      }
    }
    const filter = this.filters.find((candidate) => candidate.wants(event.requestId))
    if (filter) {
      await this.rewriteBody(targetId, event, headers, statusCode, filter)
    } else {
      await this.cdp(targetId, "Fetch.continueResponse", { requestId: event.requestId, responseCode: statusCode, responseHeaders: headers })
    }
    this.options.router.responseStarted({ ...detailed, responseHeaders: headersFromWebExt(headers) })
  }

  /** The whole body is fetched, offered to the filter and delivered again: `filterResponseData`'s round trip. */
  private async rewriteBody(
    targetId: string,
    event: FetchRequestPaused,
    headers: HttpHeader[],
    statusCode: number,
    filter: ResponseBodyFilter
  ): Promise<void> {
    const result = await this.cdp(targetId, "Fetch.getResponseBody", { requestId: event.requestId }) as { body: string; base64Encoded: boolean }
    const body = result.base64Encoded ? fromBase64(result.body) : new TextEncoder().encode(result.body)
    const rewritten = await filter.rewrite(event.requestId, body, headers)
    if (rewritten === null) {
      await this.cdp(targetId, "Fetch.continueResponse", { requestId: event.requestId, responseCode: statusCode, responseHeaders: headers })
      return
    }
    const kept = headers.filter((header) => !["content-length", "content-encoding", "transfer-encoding"].includes(header.name.toLowerCase()))
    await this.cdp(targetId, "Fetch.fulfillRequest", {
      requestId: event.requestId, responseCode: statusCode, responseHeaders: kept, body: toBase64(rewritten)
    })
  }
}

function pageUrlOf(url: string): string {
  const host = pageHostOf(url)
  if (host === null) return url
  const parsed = new URL(extensionUrlFromPageUrl(url))
  return `${pageOrigin(host)}${parsed.pathname}${parsed.search}${parsed.hash}`
}

/** Grants an own-page frame's loads of the rest of its extension, as Electron's runtime does. */
export function ownPageGrant(hosts: () => Iterable<LiteExtensionHost>, ownPages: OwnPageRequests) {
  return (url: string, documentUrl: string | null): void => {
    const extensionHost = pageHostOf(url)
    if (extensionHost === null) return
    for (const host of hosts()) {
      if (host.extension.host !== extensionHost) continue
      const document = documentUrl === null ? null : extensionUrlFromPageUrl(documentUrl)
      if (isOwnPage(host.extension, document)) ownPages.grant(extensionUrlFromPageUrl(url))
    }
  }
}

