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
  resolveExtensionRequest,
  sha256Hex
} from "@once/webext-runtime"
import { JavaChannel, RequestError } from "./javaChannel"
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
  /** Java identifies this pause, since Fetch reuses requestId at the response stage. */
  oncePause?: number
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
  hosts(): Iterable<LiteExtensionHost>
  target(targetId: string): RequestTarget | undefined
  /** The secret the document nonces derive from; the world bootstraps hold the same one. */
  token(): string
  /** Resolves when documents may proceed; the Violentmonkey hand-off holds them. */
  documentsReleased(): Promise<void>
  /**
   * Before a document continues: the answers Java serves to the document's
   * worlds' synchronous requests must be in place (registered scripts, and
   * the blob Violentmonkey named in a `Set-Cookie` of these headers).
   */
  prepareDocument?(headers: HttpHeader[], input: WebRequestDetailsInput, document: { targetId: string; frameId: string }): Promise<HttpHeader[]>
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

/**
 * The policies the grants apply to: the enforced one, and the report-only
 * one, which would otherwise report every scriptlet and synchronous request
 * of the extensions to the site.
 */
function isPolicyHeader(name: string): boolean {
  const lower = name.toLowerCase()
  return lower === "content-security-policy" || lower === "content-security-policy-report-only"
}

export function withDocumentNonce(headers: HttpHeader[], nonce: string): HttpHeader[] {
  return headers.map((header) => isPolicyHeader(header.name)
    ? { name: header.name, value: addNonceToPolicy(header.value, nonce) }
    : header)
}

/**
 * `connect-src` with the extension origins allowed. A policy that leaves
 * connections to `default-src` gets a `connect-src` of its own with the
 * same sources plus the origins, so its scripts, frames and images stay as
 * narrow as they were.
 */
export function withConnectGrant(headers: HttpHeader[], origins: string[]): HttpHeader[] {
  if (origins.length === 0) return headers
  return headers.map((header) => {
    if (!isPolicyHeader(header.name)) return header
    const directives = header.value.split(";").map((part) => part.trim()).filter(Boolean)
    const names = directives.map((directive) => directive.split(/\s+/)[0].toLowerCase())
    let index = names.indexOf("connect-src")
    if (index < 0) {
      const fallback = names.indexOf("default-src")
      if (fallback < 0) return header
      const sources = directives[fallback].split(/\s+/).slice(1).filter((source) => !/^'(?:nonce|sha256|sha384|sha512)-/.test(source))
      directives.push(["connect-src", ...sources].join(" "))
      index = directives.length - 1
    }
    const addition = origins.filter((origin) => !directives[index].includes(origin)).join(" ")
    if (!addition) return { name: header.name, value: directives.join("; ") }
    directives[index] = `${directives[index].replace(/\s*'none'/, "")} ${addition}`
    return { name: header.name, value: directives.join("; ") }
  })
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
  /** Documents held at their response stage: `tabId:frameId` → how many. */
  private readonly pendingDocuments = new Map<string, Set<WebRequestDetailsInput>>()
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
      await this.cdp(targetId, "Fetch.continueRequest", { requestId: event.requestId, oncePause: event.oncePause })
      return
    }
    try {
      if (event.responseStatusCode !== undefined || event.responseErrorReason !== undefined) {
        await this.responseStage(targetId, target, event)
      } else {
        await this.requestStage(targetId, target, event)
      }
    } catch (error) {
      // Java went on with it while the shared renderer was blocked (FetchWatchdog).
      if (error instanceof RequestError && error.code === "RELEASED") return
      this.options.channel.log("error", `Request ${event.request.url} failed in the broker: ${String(error)}`)
      await this.cdp(targetId, "Fetch.continueRequest", { requestId: event.requestId, oncePause: event.oncePause }).catch(() => undefined)
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

  /** Whether a document for the frame is held at its response stage right now. */
  isDocumentPending(tabId: number, frameId: number): boolean {
    return (this.pendingDocuments.get(`${tabId}:${frameId}`)?.size ?? 0) > 0
  }

  pendingDocument(tabId: number, frameId: number): WebRequestDetailsInput | undefined {
    const documents = this.pendingDocuments.get(`${tabId}:${frameId}`)
    // Concurrent navigations are ambiguous: never grant against an arbitrary one.
    return documents?.size === 1 ? documents.values().next().value : undefined
  }

  private holdDocument(input: WebRequestDetailsInput, held: boolean): void {
    const key = `${input.tabId}:${input.frame.frameId}`
    const documents = this.pendingDocuments.get(key) ?? new Set<WebRequestDetailsInput>()
    if (held) documents.add(input)
    else documents.delete(input)
    if (documents.size) this.pendingDocuments.set(key, documents)
    else this.pendingDocuments.delete(key)
  }

  forgetTarget(targetId: string): void {
    for (const key of [...this.records.keys()]) if (key.startsWith(`${targetId}:`)) this.records.delete(key)
    for (const key of [...this.ids.keys()]) if (key.startsWith(`${targetId}:`)) this.ids.delete(key)
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
      await this.cdp(targetId, "Fetch.failRequest", { requestId: event.requestId, oncePause: event.oncePause, errorReason: "BlockedByClient" })
      this.options.router.errorOccurred({ ...input, error: "NS_ERROR_ABORT" })
      this.forget(targetId, event.networkId ?? event.requestId)
      return
    }
    if (decision.redirectUrl) {
      const location = pageHostOf(decision.redirectUrl) ? pageUrlOf(decision.redirectUrl) : decision.redirectUrl
      await this.cdp(targetId, "Fetch.fulfillRequest", {
        requestId: event.requestId, oncePause: event.oncePause, responseCode: 307, responseHeaders: [{ name: "Location", value: location }]
      })
      return
    }
    const headers = await this.options.router.beforeSendHeaders({ ...input, requestHeaders: event.request.headers })
    if (headers.cancel) {
      await this.cdp(targetId, "Fetch.failRequest", { requestId: event.requestId, oncePause: event.oncePause, errorReason: "BlockedByClient" })
      this.forget(targetId, event.networkId ?? event.requestId)
      return
    }
    const sent = headers.requestHeaders ?? headersToWebExt(event.request.headers)
    // Told before the request goes on: Violentmonkey prepares a document's injection from it.
    this.options.router.sendHeaders({ ...input, requestHeaders: headersFromWebExt(sent) })
    await this.cdp(targetId, "Fetch.continueRequest", {
      requestId: event.requestId, oncePause: event.oncePause,
      ...(headers.requestHeaders ? { headers: headers.requestHeaders } : {})
    })
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
    const decision = host ? await this.options.router.beforeRequest({ ...input, url }) : {}
    if (!host || decision.cancel) {
      await this.cdp(targetId, "Fetch.fulfillRequest", { requestId: event.requestId, oncePause: event.oncePause, responseCode: 404, responseHeaders: [] })
      return
    }
    // Decided per request from the document that makes it: for a navigation
    // the frame's parent (its current document may be anything the parent
    // put there), else the requesting frame. In the extension's own page
    // WebView its own documents get everything; a web frame there, or a tab,
    // only what is web accessible, plus, for the extension's web-accessible
    // page inside a tab (uBlock's picker), the files that page loads. A
    // navigation in a tab never gets more than what is web accessible.
    const navigation = event.resourceType === "Document"
    const requester = requestingDocument(target.frames, event.frameId, navigation)
    const fromOwnPage = target.kind === "page" && target.pageHost === extensionHost &&
      (requester === null || pageHostOf(requester) === extensionHost)
    const grant = new OwnPageRequests()
    if (!fromOwnPage && !navigation && requester !== null && isOwnPage(host.extension, extensionUrlFromPageUrl(requester))) grant.grant(url)
    const response = resolveExtensionRequest(url, (candidate) => this.hostFor(candidate)?.extension, {
      webAccessibleOnly: !fromOwnPage,
      ownPages: grant
    })
    const generated = response instanceof Response
    let headers: HttpHeader[] = Object.entries(generated ? Object.fromEntries(response.headers) : response.headers)
      .map(([name, value]) => ({ name, value }))
    // Preserve the own-page CORS grant and web-accessible response policy.
    if (fromOwnPage) headers = withCorsGrant(headers, pageOrigin(extensionHost))
    else headers.push({ name: "Access-Control-Allow-Origin", value: "*" })
    if (generated) {
      await this.cdp(targetId, "Fetch.fulfillRequest", {
        requestId: event.requestId, oncePause: event.oncePause, responseCode: response.status,
        responseHeaders: headers, body: toBase64(new Uint8Array(await response.arrayBuffer()))
      })
    } else {
      // Permission and path decisions stay here; package bytes stay on the native
      // CDP transport, including binary assets and files from installed packages.
      await this.cdp(targetId, "Fetch.fulfillExtensionAsset", {
        requestId: event.requestId, oncePause: event.oncePause, responseCode: 200,
        responseHeaders: headers, directory: response.extension.directory, path: response.file
      })
    }
    this.forget(targetId, event.networkId ?? event.requestId)
  }

  private async responseStage(targetId: string, target: RequestTarget, event: FetchRequestPaused): Promise<void> {
    const input = this.input(targetId, target, event)
    const networkId = event.networkId ?? event.requestId
    if (event.responseErrorReason !== undefined) {
      await this.cdp(targetId, "Fetch.continueRequest", { requestId: event.requestId, oncePause: event.oncePause })
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
      await this.cdp(targetId, "Fetch.continueResponse", { requestId: event.requestId, oncePause: event.oncePause })
      return
    }
    const isDocument = input.resourceType === "mainFrame" || input.resourceType === "subFrame"
    if (isDocument) this.holdDocument(input, true)
    try {
      await this.documentResponse(targetId, target, event, input, detailed, isDocument)
    } finally {
      if (isDocument) this.holdDocument(input, false)
    }
  }

  private async documentResponse(
    targetId: string,
    target: RequestTarget,
    event: FetchRequestPaused,
    input: WebRequestDetailsInput,
    detailed: WebRequestDetailsInput,
    isDocument: boolean
  ): Promise<void> {
    const networkId = event.networkId ?? event.requestId
    const statusCode = event.responseStatusCode ?? 0
    const decision = await this.options.router.headersReceived(detailed)
    if (decision.cancel) {
      await this.cdp(targetId, "Fetch.failRequest", { requestId: event.requestId, oncePause: event.oncePause, errorReason: "BlockedByClient" })
      this.forget(targetId, networkId)
      return
    }
    let headers = decision.responseHeaders ?? event.responseHeaders ?? []
    let policyChanged = false
    if (isDocument) {
      const before = JSON.stringify(headers)
      headers = withDocumentNonce(headers, documentNonce(this.options.token(), event.request.url))
      // The worlds' synchronous requests for registered scripts must pass the page's policy.
      headers = withConnectGrant(headers, [...this.options.hosts()].map((host) => pageOrigin(host.extension.host)))
      policyChanged = JSON.stringify(headers) !== before
      if (this.options.prepareDocument) headers = await this.options.prepareDocument(headers, detailed, { targetId, frameId: event.frameId })
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
    } else if (policyChanged) {
      // Chromium enforces a document's policy from the original headers,
      // not from ones changed through `Fetch.continueResponse`; a fulfilled
      // response carries the changed ones (the author's instrumentation
      // test proved that path), with the body kept on Java's CDP transport.
      await this.fulfillWithBody(targetId, event, headers, statusCode)
    } else {
      await this.cdp(targetId, "Fetch.continueResponse", { requestId: event.requestId, oncePause: event.oncePause, responseCode: statusCode, responseHeaders: headers })
    }
    this.options.router.responseStarted({ ...detailed, responseHeaders: headersFromWebExt(headers) })
  }

  /** The response delivered again as a fulfilled one, body unchanged, so its changed headers take effect. */
  private async fulfillWithBody(targetId: string, event: FetchRequestPaused, headers: HttpHeader[], statusCode: number): Promise<void> {
    const kept = headers.filter((header) => !["content-length", "content-encoding", "transfer-encoding"].includes(header.name.toLowerCase()))
    await this.cdp(targetId, "Fetch.fulfillWithBody", {
      requestId: event.requestId, oncePause: event.oncePause, responseCode: statusCode, responseHeaders: kept
    })
  }

  /** The whole body is fetched, offered to the filter and delivered again: `filterResponseData`'s round trip. */
  private async rewriteBody(
    targetId: string,
    event: FetchRequestPaused,
    headers: HttpHeader[],
    statusCode: number,
    filter: ResponseBodyFilter
  ): Promise<void> {
    const result = await this.cdp(targetId, "Fetch.getResponseBody", { requestId: event.requestId, oncePause: event.oncePause }) as { body: string; base64Encoded: boolean }
    const body = result.base64Encoded ? fromBase64(result.body) : new TextEncoder().encode(result.body)
    const rewritten = await filter.rewrite(event.requestId, body, headers)
    if (rewritten === null) {
      await this.cdp(targetId, "Fetch.continueResponse", { requestId: event.requestId, oncePause: event.oncePause, responseCode: statusCode, responseHeaders: headers })
      return
    }
    const kept = headers.filter((header) => !["content-length", "content-encoding", "transfer-encoding"].includes(header.name.toLowerCase()))
    await this.cdp(targetId, "Fetch.fulfillRequest", {
      requestId: event.requestId, oncePause: event.oncePause, responseCode: statusCode, responseHeaders: kept, body: toBase64(rewritten)
    })
  }
}

function pageUrlOf(url: string): string {
  const host = pageHostOf(url)
  if (host === null) return url
  const parsed = new URL(extensionUrlFromPageUrl(url))
  return `${pageOrigin(host)}${parsed.pathname}${parsed.search}${parsed.hash}`
}

/**
 * The document a request comes from: the requesting frame's (a blank frame's
 * creator's), or for a navigation its parent's; null for a top-frame
 * navigation, which only Java starts in an extension page's WebView.
 */
export function requestingDocument(frames: TargetFrames, frameId: string, navigation: boolean): string | null {
  const frame = navigation ? frames.parentOf(frameId) : frameId
  if (frame === null) return null
  const url = frames.url(frame)
  return url === "" || url === "about:blank" || url === "about:srcdoc" ? frames.creatorUrlOf(frame) : url
}

