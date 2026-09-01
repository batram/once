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
  mergeBlockingResponses
} from "./webRequestDetails"

/** How long a blocking listener may hold a request before it is let through. */
const BLOCKING_TIMEOUT_MS = 3_000

interface RequestSource {
  readonly contexts: ExtensionContexts
}

export interface WebRequestRouterOptions {
  /** Extension tab id for a webContents, or -1 when the request has no tab. */
  tabIdFor(webContentsId: number | undefined): number
  /** Every loaded extension, in the order their listeners run. */
  sources(): RequestSource[]
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
    this.session.webRequest.onCompleted(filter, (details) => {
      this.notify("onCompleted", buildWebRequestDetails({
        ...this.baseInput(details),
        statusLine: details.statusLine,
        statusCode: details.statusCode
      }))
    })
    this.session.webRequest.onErrorOccurred(filter, (details) => {
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
        source.contexts.emitTo(target, "webRequest", event, [details])
      }
    }
  }

  private async beforeRequest(
    details: Electron.OnBeforeRequestListenerDetails
  ): Promise<Electron.CallbackResponse> {
    const merged = await this.dispatch(
      "onBeforeRequest",
      buildWebRequestDetails(this.baseInput(details))
    )
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
    const merged = await this.dispatch(
      "onHeadersReceived",
      buildWebRequestDetails({
        ...this.baseInput(details),
        responseHeaders: details.responseHeaders ?? {},
        statusLine: details.statusLine,
        statusCode: details.statusCode
      })
    )
    if (merged.cancel) return { cancel: true }
    if (merged.responseHeaders) {
      return { responseHeaders: headersFromWebExt(merged.responseHeaders) }
    }
    return {}
  }
}
