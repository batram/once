// Fans each browser-session request out to every extension context that
// registered a matching webRequest listener, awaits the blocking ones, and
// applies declarativeNetRequest rules around them. Pure: a host adapter
// (Electron's `session.webRequest`, Lite's DevTools `Fetch` domain) turns its
// own request records into `WebRequestDetailsInput` and feeds the stage
// methods here, then maps the decisions back.

import type { LoadedExtension } from "./LoadedExtension"
import { permittedHosts } from "./extensionPermissions"
import { ExtensionContexts, EventTarget, ListenerRecord } from "./ExtensionContexts"
import {
  BlockingResponse,
  CompiledRequestFilter,
  HttpHeader,
  WebRequestDetails,
  WebRequestDetailsInput,
  buildWebRequestDetails,
  headersToWebExt,
  mergeBlockingResponses,
  startsDocument,
  webExtResourceType
} from "./webRequestDetails"

/** How long a blocking listener may hold a request before it is let through. */
const BLOCKING_TIMEOUT_MS = 3_000

/** How long a document's headers wait for `onResponseStarted` listeners. */
const DOCUMENT_RESPONSE_TIMEOUT_MS = 1_000

export interface RequestSource {
  readonly contexts: ExtensionContexts
  readonly extension: LoadedExtension
}

export interface WebRequestRouterOptions {
  /** Every loaded extension, in the order their listeners run. */
  sources(): RequestSource[]
  /**
   * Every request, with the URL of the document that makes it, before any
   * listener sees it: the protocol handler for extension URLs learns who
   * asks only this way.
   */
  requestFrom?(url: string, documentUrl: string | null): void
  /** The declarativeNetRequest rules of every extension, consulted first. */
  declarative?: DeclarativeRequestHooks
}

/** What `dnrBridge` answers for a request at each stage. */
export interface DeclarativeRequestHooks {
  beforeRequest(details: WebRequestDetails): { cancel?: boolean; redirectUrl?: string }
  requestHeaders(details: WebRequestDetails, headers: readonly HttpHeader[]): HttpHeader[] | null
  responseHeaders(details: WebRequestDetails, headers: readonly HttpHeader[]): HttpHeader[] | null
}

export interface RequestDecision {
  cancel?: boolean
  redirectUrl?: string
}

export interface RequestHeadersDecision {
  cancel?: boolean
  /** The complete request header set to send, when a listener or a rule changed it. */
  requestHeaders?: HttpHeader[]
}

export interface ResponseHeadersDecision {
  cancel?: boolean
  /** The complete response header set to deliver, when a listener or a rule changed it. */
  responseHeaders?: HttpHeader[]
}

/** What the listeners of one context asked for, taken together. */
interface TargetCapabilities {
  blocking: boolean
  requestHeaders: boolean
  responseHeaders: boolean
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

export class WebRequestRouter {
  /** Requests whose `onResponseStarted` went out with their headers. */
  private readonly startedEarly = new Set<number>()

  constructor(private readonly options: WebRequestRouterOptions) {}

  private matchingTargets(source: RequestSource, event: string, details: WebRequestDetails): EventTarget[] {
    if (!source.extension.manifest.permissions.has("webRequest") ||
        !permittedHosts(source.extension).matches(details.url)) return []
    return source.contexts.targets("webRequest", event, (spec) => {
      const filter = compiled(spec)
      return filter !== null && filter.matches(details) &&
        (!filter.blocking || source.extension.manifest.permissions.has("webRequestBlocking"))
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

  /** Blocking stage: `onBeforeRequest`, after the declarative rules. */
  async beforeRequest(input: WebRequestDetailsInput): Promise<RequestDecision> {
    this.options.requestFrom?.(input.url, input.frame.documentUrl)
    const built = buildWebRequestDetails(input)
    // A declarative block ends the request before any listener sees it, as
    // Firefox orders the two; a declarative redirect yields to a listener's.
    const declared = this.options.declarative?.beforeRequest(built) ?? {}
    if (declared.cancel) return { cancel: true }
    const merged = await this.dispatch("onBeforeRequest", built)
    if (merged.cancel) return { cancel: true }
    const redirect = merged.redirectUrl ?? declared.redirectUrl
    if (redirect) return { redirectUrl: redirect }
    return {}
  }

  /** Blocking stage: `onBeforeSendHeaders`, then the rules' header changes on top. */
  async beforeSendHeaders(input: WebRequestDetailsInput): Promise<RequestHeadersDecision> {
    const built = buildWebRequestDetails(input)
    const merged = await this.dispatch("onBeforeSendHeaders", built)
    if (merged.cancel) return { cancel: true }
    const headers = merged.requestHeaders ?? headersToWebExt(input.requestHeaders ?? {})
    const modified = this.options.declarative?.requestHeaders(built, headers) ?? null
    const result = modified ?? merged.requestHeaders
    if (result) return { requestHeaders: result }
    return {}
  }

  /**
   * Blocking stage: `onHeadersReceived`. For a response about to become a
   * document, `onResponseStarted` is raised and awaited here as well, while
   * the headers are still held (see `documentResponseStarted`).
   */
  async headersReceived(input: WebRequestDetailsInput): Promise<ResponseHeadersDecision> {
    const built = buildWebRequestDetails(input)
    const merged = await this.dispatch("onHeadersReceived", built)
    if (merged.cancel) return { cancel: true }
    if (startsDocument(webExtResourceType(input.resourceType), input.statusCode ?? 0)) {
      this.startedEarly.add(input.id)
      await this.documentResponseStarted(buildWebRequestDetails(input))
    }
    const headers = merged.responseHeaders ?? headersToWebExt(input.responseHeaders ?? {})
    const modified = this.options.declarative?.responseHeaders(built, headers) ?? null
    const result = modified ?? merged.responseHeaders
    if (result) return { responseHeaders: result }
    return {}
  }

  sendHeaders(input: WebRequestDetailsInput): void {
    this.notify("onSendHeaders", buildWebRequestDetails(input))
  }

  /** Skipped for a document whose listeners already ran from `headersReceived`. */
  responseStarted(input: WebRequestDetailsInput): void {
    if (this.startedEarly.delete(input.id)) return
    this.notify("onResponseStarted", buildWebRequestDetails(input))
  }

  beforeRedirect(input: WebRequestDetailsInput): void {
    this.startedEarly.delete(input.id)
    this.notify("onBeforeRedirect", buildWebRequestDetails(input))
  }

  completed(input: WebRequestDetailsInput): void {
    this.startedEarly.delete(input.id)
    this.notify("onCompleted", buildWebRequestDetails(input))
  }

  errorOccurred(input: WebRequestDetailsInput): void {
    this.startedEarly.delete(input.id)
    this.notify("onErrorOccurred", buildWebRequestDetails(input))
  }

  /**
   * A document's `onResponseStarted`, raised while its headers are still
   * held and awaited until the listeners return. uBlock registers a page's
   * scriptlets from this listener, and a registration that arrives after the
   * renderer created the document misses it: Firefox's parent process runs
   * these listeners before the content process gets the response, and a
   * listener's calls reach the privileged side before its return does, so
   * waiting here gives the same order. The host's own later
   * `onResponseStarted` for the request is skipped.
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
