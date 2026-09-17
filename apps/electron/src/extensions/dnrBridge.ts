// Where `declarativeNetRequest` meets the browser session's requests: the
// webRequest router hands each request here before and after its blocking
// listeners run, and every extension's matcher is asked in turn. Pure, so
// tests drive it with fabricated details.
//
// Across extensions the first block wins, then the first redirect or
// upgrade; modifyHeaders rules of every extension apply on top of whatever
// the webRequest listeners returned. `allowAllRequests` is remembered per
// frame: the requests a matched frame goes on to make are allowed at that
// rule's priority within the same extension.

import { DnrDecision, DnrHeader, DnrMatcher, DnrRequest, applyHeaderModifications } from "@once/core"
import { HttpHeader, WebRequestDetails } from "./webRequestDetails"

export interface DnrSource {
  readonly extensionId: string
  matcher(): DnrMatcher | null
}

export interface DeclarativeOutcome {
  cancel?: boolean
  redirectUrl?: string
}

/** How many frames an extension's allowAllRequests grants are kept for. */
const MAX_ALLOWED_FRAMES = 256

export class DnrEnforcer {
  /** Per extension: `tabId|frameUrl` → allowAllRequests priority. */
  private readonly allowedFrames = new Map<string, Map<string, number>>()

  constructor(private readonly sources: () => Iterable<DnrSource>) {}

  private request(source: DnrSource, details: WebRequestDetails): DnrRequest {
    const initiator = details.documentUrl ?? null
    const request: DnrRequest = {
      url: details.url,
      type: details.type,
      method: details.method,
      initiator,
      tabId: details.tabId
    }
    const frames = this.allowedFrames.get(source.extensionId)
    if (!frames || details.tabId < 0) return request
    const candidates = [initiator, details.frameAncestors[0]?.url].filter((url): url is string => !!url)
    let priority: number | undefined
    for (const url of candidates) {
      const granted = frames.get(`${details.tabId}|${url}`)
      if (granted !== undefined && (priority === undefined || granted > priority)) priority = granted
    }
    return priority === undefined ? request : { ...request, frameAllowPriority: priority }
  }

  private remember(source: DnrSource, details: WebRequestDetails, decision: DnrDecision): void {
    if (decision.rule?.action.type !== "allowAllRequests" || details.tabId < 0) return
    let frames = this.allowedFrames.get(source.extensionId)
    if (!frames) {
      frames = new Map()
      this.allowedFrames.set(source.extensionId, frames)
    }
    if (frames.size >= MAX_ALLOWED_FRAMES) {
      const oldest = frames.keys().next().value
      if (oldest !== undefined) frames.delete(oldest)
    }
    frames.set(`${details.tabId}|${details.url}`, decision.rule.priority)
  }

  private *decisions(details: WebRequestDetails): Generator<[DnrSource, DnrDecision]> {
    for (const source of this.sources()) {
      const matcher = source.matcher()
      if (!matcher || matcher.size === 0) continue
      yield [source, matcher.evaluate(this.request(source, details))]
    }
  }

  /** What the rules ask before the request goes out. */
  beforeRequest(details: WebRequestDetails): DeclarativeOutcome {
    const outcome: DeclarativeOutcome = {}
    for (const [source, decision] of this.decisions(details)) {
      this.remember(source, details, decision)
      if (decision.outcome === "block") return { cancel: true }
      if (decision.redirectUrl !== undefined && outcome.redirectUrl === undefined) {
        outcome.redirectUrl = decision.redirectUrl
      }
    }
    return outcome
  }

  private modified(
    details: WebRequestDetails,
    headers: readonly HttpHeader[],
    kind: "requestHeaders" | "responseHeaders"
  ): HttpHeader[] | null {
    let current: DnrHeader[] | null = null
    for (const [, decision] of this.decisions(details)) {
      if (decision.modifyHeaders.length === 0) continue
      const next = applyHeaderModifications(current ?? headers, decision.modifyHeaders, kind)
      if (next) current = next
    }
    return current
  }

  /** The request headers after modifyHeaders rules, or null when untouched. */
  requestHeaders(details: WebRequestDetails, headers: readonly HttpHeader[]): HttpHeader[] | null {
    return this.modified(details, headers, "requestHeaders")
  }

  /** The response headers after modifyHeaders rules, or null when untouched. */
  responseHeaders(details: WebRequestDetails, headers: readonly HttpHeader[]): HttpHeader[] | null {
    return this.modified(details, headers, "responseHeaders")
  }

  forgetTab(tabId: number): void {
    const prefix = `${tabId}|`
    for (const frames of this.allowedFrames.values()) {
      for (const key of [...frames.keys()]) if (key.startsWith(prefix)) frames.delete(key)
    }
  }
}
