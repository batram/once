import { Session, WebFrameMain } from "electron"
import { ExtensionContexts, EventTarget, ListenerRecord } from "./ExtensionContexts"
import {
  BlockingResponse,
  CompiledRequestFilter,
  FrameFacts,
  NO_FRAME,
  WebRequestDetails,
  WebRequestDetailsInput,
  buildWebRequestDetails,
  headersFromWebExt,
  mergeBlockingResponses,
  startsDocument,
  webExtResourceType
} from "./webRequestDetails"

/** How long a blocking listener may hold a request before it is let through. */
const BLOCKING_TIMEOUT_MS = 3_000

/** How long a document's headers wait for `onResponseStarted` listeners. */
const DOCUMENT_RESPONSE_TIMEOUT_MS = 1_000

interface RequestSource {
  readonly contexts: ExtensionContexts
}

export interface WebRequestRouterOptions {
  /** Extension tab id for a webContents, or -1 when the request has no tab. */
  tabIdFor(webContentsId: number | undefined): number
  /** Every loaded extension, in the order their listeners run. */
  sources(): RequestSource[]
  /**
   * Every request, with the URL of the document that makes it, before any
   * listener sees it: the protocol handler for extension URLs learns who
   * asks only this way.
   */
  requestFrom?(url: string, documentUrl: string | null): void
}

interface ElectronRequestDetails {
  id: number
  url: string
  method: string
  resourceType: string
  referrer: string
  timestamp: number
  webContentsId?: number
  frame?: WebFrameMain | null
}

/** What the listeners of one context asked for, taken together. */
interface TargetCapabilities {
  blocking: boolean
  requestHeaders: boolean
  responseHeaders: boolean
}

function frameFacts(frame: WebFrameMain | null | undefined): FrameFacts {
  if (!frame) return NO_FRAME
  try {
    const parent = frame.parent
    const frameId = parent === null ? 0 : frame.frameTreeNodeId
    const parentFrameId = parent === null
      ? -1
      : parent.parent === null ? 0 : parent.frameTreeNodeId
    return {
      frameId,
      parentFrameId,
      documentUrl: frame.url || null,
      topUrl: frame.top?.url || null
    }
  } catch {
    // The frame was destroyed between the request and this lookup.
    return NO_FRAME
  }
}

const compiledFilters = new WeakMap<object, CompiledRequestFilter>()

function compiled(spec: ListenerRecord): CompiledRequestFilter | null {
  if (!spec) return null
  let filter = compiledFilters.get(spec)
  if (!filter) {
    try {
      filter = new CompiledRequestFilter(spec)
    } catch {
      return null
    }
    compiledFilters.set(spec, filter)
  }
  return filter
}

function capabilities(target: EventTarget, event: string): TargetCapabilities {
  const specs = target.entry.listeners.get(`webRequest.${event}`)
  const result: TargetCapabilities = { blocking: false, requestHeaders: false, responseHeaders: false }
  for (const id of target.listenerIds) {
    const filter = compiled(specs?.get(id) ?? null)
    if (!filter) continue
    result.blocking ||= filter.blocking
    result.requestHeaders ||= filter.wantsRequestHeaders
    result.responseHeaders ||= filter.wantsResponseHeaders
  }
  return result
}

/** Headers only reach listeners that asked for them in `extraInfoSpec`. */
function payloadFor(details: WebRequestDetails, caps: TargetCapabilities): WebRequestDetails {
  const payload = { ...details }
  if (!caps.requestHeaders) delete payload.requestHeaders
  if (!caps.responseHeaders) delete payload.responseHeaders
  return payload
}

/**
 * Owns the one listener Electron allows per webRequest event on the browser
 * session and fans each request out to every extension context that
 * registered a matching listener, waiting for the blocking ones.
 */
export class WebRequestRouter {
  /** Requests whose `onResponseStarted` went out with their headers. */
  private readonly startedEarly = new Set<number>()

  constructor(
    private readonly session: Session,
    private readonly options: WebRequestRouterOptions
  ) {}

  install(): void {
    const filter = { urls: ["<all_urls>"] }
    this.session.webRequest.onBeforeRequest(filter, (details, callback) => {
      void this.beforeRequest(details).then(callback)
    })
    this.session.webRequest.onBeforeSendHeaders(filter, (details, callback) => {
      void this.beforeSendHeaders(details).then(callback)
    })
    this.session.webRequest.onHeadersReceived(filter, (details, callback) => {
      void this.headersReceived(details).then(callback)
    })
    this.session.webRequest.onSendHeaders(filter, (details) => {
      this.notify("onSendHeaders", buildWebRequestDetails({
        ...this.baseInput(details),
        requestHeaders: details.requestHeaders
      }))
    })
    this.session.webRequest.onResponseStarted(filter, (details) => {
      if (this.startedEarly.delete(details.id)) return
      this.notify("onResponseStarted", buildWebRequestDetails({
        ...this.baseInput(details),
        responseHeaders: details.responseHeaders ?? {},
        statusLine: details.statusLine,
        statusCode: details.statusCode,
        fromCache: details.fromCache
      }))
    })
    this.session.webRequest.onBeforeRedirect(filter, (details) => {
      this.startedEarly.delete(details.id)
      this.notify("onBeforeRedirect", buildWebRequestDetails({
        ...this.baseInput(details),
        responseHeaders: details.responseHeaders ?? {},
        statusLine: details.statusLine,
        statusCode: details.statusCode,
        redirectUrl: details.redirectURL,
        fromCache: details.fromCache
      }))
    })
    this.session.webRequest.onCompleted(filter, (details) => {
      this.startedEarly.delete(details.id)
      this.notify("onCompleted", buildWebRequestDetails({
        ...this.baseInput(details),
        statusLine: details.statusLine,
        statusCode: details.statusCode
      }))
    })
    this.session.webRequest.onErrorOccurred(filter, (details) => {
      this.startedEarly.delete(details.id)
      this.notify("onErrorOccurred", buildWebRequestDetails({
        ...this.baseInput(details),
        error: details.error
      }))
    })
  }

  private baseInput(details: ElectronRequestDetails): WebRequestDetailsInput {
    return {
      id: details.id,
      url: details.url,
      method: details.method,
      resourceType: details.resourceType,
      referrer: details.referrer,
      timestamp: details.timestamp,
      tabId: this.options.tabIdFor(details.webContentsId),
      frame: frameFacts(details.frame)
    }
  }

  private matchingTargets(source: RequestSource, event: string, details: WebRequestDetails): EventTarget[] {
    return source.contexts.targets("webRequest", event, (spec) => {
      const filter = compiled(spec)
      return filter !== null && filter.matches(details)
    })
  }

  private async dispatch(event: string, details: WebRequestDetails): Promise<BlockingResponse> {
    const responses: unknown[] = []
    for (const source of this.options.sources()) {
      for (const target of this.matchingTargets(source, event, details)) {
        const caps = capabilities(target, event)
        const payload = payloadFor(details, caps)
        if (!caps.blocking) {
          source.contexts.emitTo(target, "webRequest", event, [payload])
          continue
        }
        responses.push(...await source.contexts.request(
          target, "webRequest", event, [payload], BLOCKING_TIMEOUT_MS
        ))
        if (mergeBlockingResponses(responses).cancel) return { cancel: true }
      }
    }
    return mergeBlockingResponses(responses)
  }

  private notify(event: string, details: WebRequestDetails): void {
    for (const source of this.options.sources()) {
      for (const target of this.matchingTargets(source, event, details)) {
        const payload = payloadFor(details, capabilities(target, event))
        source.contexts.emitTo(target, "webRequest", event, [payload])
      }
    }
  }

  private async beforeRequest(
    details: Electron.OnBeforeRequestListenerDetails
  ): Promise<Electron.CallbackResponse> {
    const input = this.baseInput(details)
    this.options.requestFrom?.(input.url, input.frame.documentUrl)
    const merged = await this.dispatch("onBeforeRequest", buildWebRequestDetails(input))
    if (merged.cancel) return { cancel: true }
    if (merged.redirectUrl) return { redirectURL: merged.redirectUrl }
    return {}
  }

  private async beforeSendHeaders(
    details: Electron.OnBeforeSendHeadersListenerDetails
  ): Promise<Electron.BeforeSendResponse> {
    const merged = await this.dispatch(
      "onBeforeSendHeaders",
      buildWebRequestDetails({ ...this.baseInput(details), requestHeaders: details.requestHeaders })
    )
    if (merged.cancel) return { cancel: true }
    if (merged.requestHeaders) return { requestHeaders: headersFromWebExt(merged.requestHeaders) }
    return {}
  }

  private async headersReceived(
    details: Electron.OnHeadersReceivedListenerDetails
  ): Promise<Electron.HeadersReceivedResponse> {
    const input: WebRequestDetailsInput = {
      ...this.baseInput(details),
      responseHeaders: details.responseHeaders ?? {},
      statusLine: details.statusLine,
      statusCode: details.statusCode
    }
    const merged = await this.dispatch("onHeadersReceived", buildWebRequestDetails(input))
    if (merged.cancel) return { cancel: true }
    if (startsDocument(webExtResourceType(input.resourceType), input.statusCode ?? 0)) {
      this.startedEarly.add(details.id)
      await this.documentResponseStarted(buildWebRequestDetails(input))
    }
    if (merged.responseHeaders) {
      return { responseHeaders: headersFromWebExt(merged.responseHeaders) }
    }
    return {}
  }

  /**
   * A document's `onResponseStarted`, raised while its headers are still
   * held and awaited until the listeners return. uBlock registers a page's
   * scriptlets from this listener, and a registration that arrives after the
   * renderer created the document misses it: Firefox's parent process runs
   * these listeners before the content process gets the response, and a
   * listener's calls reach main before its return does, so waiting here
   * gives the same order. Electron's own onResponseStarted for the request
   * comes after the renderer has the response, and is skipped.
   */
  private async documentResponseStarted(details: WebRequestDetails): Promise<void> {
    const waits: Promise<unknown>[] = []
    for (const source of this.options.sources()) {
      for (const target of this.matchingTargets(source, "onResponseStarted", details)) {
        const payload = payloadFor(details, capabilities(target, "onResponseStarted"))
        waits.push(source.contexts.request(
          target, "webRequest", "onResponseStarted", [payload], DOCUMENT_RESPONSE_TIMEOUT_MS
        ))
      }
    }
    await Promise.all(waits)
  }
}
