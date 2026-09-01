// The pure half of webRequest: turning what Electron reports into the
// `details` object a WebExtension listener expects, deciding which
// listeners a request concerns, and merging their blocking responses.
// No Electron imports, so it is exercised directly by unit tests.

import { MatchPatternSet } from "@once/core"

export type WebExtResourceType =
  | "main_frame" | "sub_frame" | "stylesheet" | "script" | "image" | "font"
  | "object" | "xmlhttprequest" | "ping" | "csp_report" | "media"
  | "websocket" | "other"

const RESOURCE_TYPES: Readonly<Record<string, WebExtResourceType>> = {
  mainFrame: "main_frame",
  subFrame: "sub_frame",
  stylesheet: "stylesheet",
  script: "script",
  image: "image",
  font: "font",
  object: "object",
  xhr: "xmlhttprequest",
  ping: "ping",
  cspReport: "csp_report",
  media: "media",
  webSocket: "websocket"
}

export function webExtResourceType(electronType: string): WebExtResourceType {
  return RESOURCE_TYPES[electronType] ?? "other"
}

export interface HttpHeader {
  name: string
  value: string
}

export function headersToWebExt(
  headers: Readonly<Record<string, string | string[]>>
): HttpHeader[] {
  const result: HttpHeader[] = []
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const item of value) result.push({ name, value: item })
    } else {
      result.push({ name, value })
    }
  }
  return result
}

export function headersFromWebExt(
  headers: readonly HttpHeader[]
): Record<string, string | string[]> {
  const result: Record<string, string | string[]> = {}
  for (const { name, value } of headers) {
    const existing = result[name]
    if (existing === undefined) result[name] = value
    else if (Array.isArray(existing)) existing.push(value)
    else result[name] = [existing, value]
  }
  return result
}

/** The frame facts the router extracts from a `WebFrameMain` before mapping. */
export interface FrameFacts {
  frameId: number
  parentFrameId: number
  /** The frame's document URL, which Firefox reports as `documentUrl`. */
  documentUrl: string | null
  /** The top document's URL. */
  topUrl: string | null
}

export const NO_FRAME: FrameFacts = {
  frameId: 0,
  parentFrameId: -1,
  documentUrl: null,
  topUrl: null
}

export interface WebRequestDetailsInput {
  id: number
  url: string
  method: string
  resourceType: string
  referrer: string
  timestamp: number
  tabId: number
  frame: FrameFacts
  requestHeaders?: Readonly<Record<string, string | string[]>>
  responseHeaders?: Readonly<Record<string, string | string[]>>
  statusLine?: string
  statusCode?: number
  error?: string
  redirectUrl?: string
  fromCache?: boolean
}

export interface WebRequestDetails {
  requestId: string
  url: string
  method: string
  type: WebExtResourceType
  timeStamp: number
  tabId: number
  frameId: number
  parentFrameId: number
  originUrl: string | null
  documentUrl: string | null
  /** Firefox-only, but uBlock reads it: the top-level document's URL. */
  frameAncestors: { url: string; frameId: number }[]
  thirdParty: boolean
  requestHeaders?: HttpHeader[]
  responseHeaders?: HttpHeader[]
  statusLine?: string
  statusCode?: number
  error?: string
  redirectUrl?: string
  fromCache?: boolean
}

function registrableDomain(hostname: string): string {
  // Good enough for third-party detection without a public suffix list: the
  // last two labels, which is what uBlock recomputes anyway from its own list.
  const labels = hostname.split(".")
  return labels.length <= 2 ? hostname : labels.slice(-2).join(".")
}

function isThirdParty(url: string, documentUrl: string | null): boolean {
  if (!documentUrl) return false
  try {
    return registrableDomain(new URL(url).hostname) !==
      registrableDomain(new URL(documentUrl).hostname)
  } catch {
    return false
  }
}

export function buildWebRequestDetails(input: WebRequestDetailsInput): WebRequestDetails {
  const type = webExtResourceType(input.resourceType)
  const isMainFrame = type === "main_frame"
  // For a main-frame navigation the initiating document is the one being
  // replaced; Firefox reports no documentUrl there, and uBlock relies on that.
  const documentUrl = isMainFrame ? null : input.frame.documentUrl
  const details: WebRequestDetails = {
    requestId: String(input.id),
    url: input.url,
    method: input.method,
    type,
    timeStamp: input.timestamp,
    tabId: input.tabId,
    frameId: isMainFrame ? 0 : input.frame.frameId,
    parentFrameId: isMainFrame ? -1 : input.frame.parentFrameId,
    originUrl: documentUrl ?? (input.referrer || null),
    documentUrl,
    frameAncestors: !isMainFrame && input.frame.topUrl && input.frame.frameId !== 0
      ? [{ url: input.frame.topUrl, frameId: 0 }]
      : [],
    thirdParty: isThirdParty(input.url, documentUrl ?? input.frame.topUrl)
  }
  if (input.requestHeaders) details.requestHeaders = headersToWebExt(input.requestHeaders)
  if (input.responseHeaders) details.responseHeaders = headersToWebExt(input.responseHeaders)
  if (input.statusLine !== undefined) details.statusLine = input.statusLine
  if (input.statusCode !== undefined) details.statusCode = input.statusCode
  if (input.error !== undefined) details.error = input.error
  if (input.redirectUrl !== undefined) details.redirectUrl = input.redirectUrl
  if (input.fromCache !== undefined) details.fromCache = input.fromCache
  return details
}

export interface RequestFilter {
  urls: readonly string[]
  types?: readonly WebExtResourceType[]
  tabId?: number
}

export interface WebRequestListenerSpec {
  filter: RequestFilter
  extraInfoSpec: readonly string[]
}

export class CompiledRequestFilter {
  private readonly urls: MatchPatternSet
  private readonly types: ReadonlySet<string> | null
  private readonly tabId: number | null
  readonly blocking: boolean
  readonly wantsRequestHeaders: boolean
  readonly wantsResponseHeaders: boolean

  constructor(spec: WebRequestListenerSpec) {
    if (!Array.isArray(spec.filter?.urls) || spec.filter.urls.length === 0) {
      throw new Error("webRequest listeners need a urls filter")
    }
    this.urls = new MatchPatternSet(spec.filter.urls)
    this.types = spec.filter.types ? new Set(spec.filter.types) : null
    this.tabId = typeof spec.filter.tabId === "number" ? spec.filter.tabId : null
    const extra = new Set(spec.extraInfoSpec ?? [])
    this.blocking = extra.has("blocking")
    this.wantsRequestHeaders = extra.has("requestHeaders")
    this.wantsResponseHeaders = extra.has("responseHeaders")
  }

  matches(details: WebRequestDetails): boolean {
    if (this.types && !this.types.has(details.type)) return false
    if (this.tabId !== null && this.tabId !== details.tabId) return false
    return this.urls.matches(details.url)
  }
}

export interface BlockingResponse {
  cancel?: boolean
  redirectUrl?: string
  requestHeaders?: HttpHeader[]
  responseHeaders?: HttpHeader[]
}

function isBlockingResponse(value: unknown): value is BlockingResponse {
  return typeof value === "object" && value !== null
}

/**
 * Firefox semantics: any cancel cancels; the first redirect wins; the last
 * listener to return headers has its whole set applied.
 */
export function mergeBlockingResponses(responses: readonly unknown[]): BlockingResponse {
  const merged: BlockingResponse = {}
  for (const response of responses) {
    if (!isBlockingResponse(response)) continue
    if (response.cancel === true) merged.cancel = true
    if (typeof response.redirectUrl === "string" && merged.redirectUrl === undefined) {
      merged.redirectUrl = response.redirectUrl
    }
    if (Array.isArray(response.requestHeaders)) {
      merged.requestHeaders = response.requestHeaders
    }
    if (Array.isArray(response.responseHeaders)) {
      merged.responseHeaders = response.responseHeaders
    }
  }
  return merged
}
