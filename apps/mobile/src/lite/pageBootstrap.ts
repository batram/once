// Runs at document start in every frame of an extension page WebView
// (`WebViewCompat.addDocumentStartJavaScript`, restricted to the extension's
// https origin) and builds the `browser`/`chrome` object the page expects,
// synchronously, from `window.__onceLitePageInit` and the `onceLitePage`
// WebMessage channel Java injected into the same frame. Calls go to the
// broker through Java; events come back the same way. A popup reports the
// size its body laid out to, as Electron's preload does.

import {
  BRIDGE_STAGING_KEY,
  EXTENSION_API_SURFACE,
  ExtensionContextInit,
  PreloadApi,
  adoptBridge,
  decorateExtensionPage,
  unwrapInvoke
} from "@once/webext-runtime/preload"
import { BLOB_API, BrokerToPageMessage, PAGE_CHANNEL, PageToBrokerMessage, pageUrlFromExtensionUrl } from "./protocol"

interface PagePort {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

type Scope = typeof globalThis & {
  __onceLitePageInit?: ExtensionContextInit
  onceLitePage?: PagePort
  [BRIDGE_STAGING_KEY]?: unknown
}

/** `filterResponseData` is a stream in Firefox; here the whole body arrives at once (see the protocol doc). */
export function streamFilterUnavailable(): never {
  throw new Error("webRequest.filterResponseData is not available on Once Lite")
}

/**
 * `moz-extension://<host>/…` is what `runtime.getURL` hands the page and
 * what it puts into requests and element sources, but the WebView can load
 * only the https form: the request and element APIs map the scheme (the
 * page's `location` stays https). Covered: `fetch`, `Request`, `XMLHttpRequest`,
 * `navigator.sendBeacon`, and the `src`/`href` of images, scripts, frames,
 * links and media, including `setAttribute`.
 */
export function mapExtensionUrls(scope: typeof globalThis): void {
  const map = (value: unknown): unknown => typeof value === "string" ? pageUrlFromExtensionUrl(value)
    : value instanceof URL ? new URL(pageUrlFromExtensionUrl(value.href)) : value
  const originalFetch = scope.fetch
  scope.fetch = ((input: RequestInfo | URL, init?: RequestInit) => originalFetch.call(scope, map(input) as RequestInfo, init)) as typeof fetch
  const OriginalRequest = scope.Request
  scope.Request = new Proxy(OriginalRequest, {
    construct: (target, [input, init]) => Reflect.construct(target, [map(input), init])
  })
  const open = scope.XMLHttpRequest.prototype.open
  scope.XMLHttpRequest.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
    return (open as (...args: unknown[]) => void).call(this, method, map(url), ...rest)
  } as typeof open
  if (scope.navigator?.sendBeacon) {
    const sendBeacon = scope.navigator.sendBeacon
    scope.navigator.sendBeacon = (url: string | URL, data?: BodyInit | null) => sendBeacon.call(scope.navigator, map(url) as string, data)
  }
  const sources: [{ prototype: object } | undefined, string][] = [
    [scope.HTMLImageElement, "src"], [scope.HTMLScriptElement, "src"], [scope.HTMLIFrameElement, "src"],
    [scope.HTMLMediaElement, "src"], [scope.HTMLSourceElement, "src"], [scope.HTMLLinkElement, "href"], [scope.HTMLAnchorElement, "href"]
  ]
  for (const [constructor, name] of sources) {
    const prototype = constructor?.prototype
    const descriptor = prototype && Object.getOwnPropertyDescriptor(prototype, name)
    if (!descriptor?.set) continue
    const set = descriptor.set
    Object.defineProperty(prototype, name, { ...descriptor, set(this: object, value: unknown) { set.call(this, map(value)) } })
  }
  const setAttribute = scope.Element.prototype.setAttribute
  scope.Element.prototype.setAttribute = function (this: Element, name: string, value: string) {
    const lower = name.toLowerCase()
    setAttribute.call(this, name, lower === "src" || lower === "href" ? pageUrlFromExtensionUrl(String(value)) : value)
  }
}

function reportPopupSize(post: (message: PageToBrokerMessage) => void): void {
  const send = (): void => {
    const body = document.body
    if (!body) return
    const rect = body.getBoundingClientRect()
    const style = getComputedStyle(body)
    const margin = (value: string): number => Number.parseFloat(value) || 0
    post({
      type: "popup-size",
      width: Math.ceil(Math.max(rect.width, body.scrollWidth) + margin(style.marginLeft) + margin(style.marginRight)),
      height: Math.ceil(Math.max(rect.height, body.scrollHeight) + margin(style.marginTop) + margin(style.marginBottom))
    })
  }
  const observe = (): void => {
    if (!document.body) return
    new ResizeObserver(send).observe(document.body)
    send()
  }
  if (document.body) observe()
  else document.addEventListener("DOMContentLoaded", observe, { once: true })
}

export function bootstrapExtensionPage(scope: Scope = globalThis as Scope): void {
  const init = scope.__onceLitePageInit
  const port = scope[PAGE_CHANNEL as "onceLitePage"]
  delete scope.__onceLitePageInit
  if (!init || !port) return
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  let nextId = 1
  const post = (message: PageToBrokerMessage): void => port.postMessage(JSON.stringify({ ...message, href: location.href }))
  window.addEventListener("pagehide", (event) => {
    if (!event.persisted) port.postMessage(JSON.stringify({ type: "frame-gone" }))
  })
  const api = new PreloadApi(init, EXTENSION_API_SURFACE, {
    invoke: (namespace, method, args) => new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      let encoded: string
      try {
        encoded = JSON.stringify({ type: "invoke", id, api: namespace, method, args, href: location.href })
      } catch {
        pending.delete(id)
        reject(new Error(`browser.${namespace}.${method}: an argument could not be cloned`))
        return
      }
      port.postMessage(encoded)
    }),
    reply: (token, result) => post({ type: "reply", token, result }),
    listen: (change) => post({ type: "listen", change })
  })
  port.onmessage = (event) => {
    let message: BrokerToPageMessage
    try {
      message = JSON.parse(event.data)
    } catch {
      return
    }
    if (message.type === "result") {
      const waiting = pending.get(message.id)
      if (!waiting) return
      pending.delete(message.id)
      try {
        waiting.resolve(unwrapInvoke(message.result))
      } catch (error) {
        waiting.reject(error as Error)
      }
    } else if (message.type === "event") {
      const event = message.message
      if (event.api === BLOB_API && typeof event.token === "number") {
        // The broker reads one of this extension's blob URLs through its own page.
        const token = event.token
        const [{ url }] = event.args as [{ url: string }]
        originalFetch(url).then((response) => response.text()).then(
          (text) => post({ type: "reply", token, result: [text] }),
          () => post({ type: "reply", token, result: [null] })
        )
        return
      }
      api.handleEvent(event)
    }
  }
  const originalFetch = scope.fetch
  mapExtensionUrls(scope)
  const browser = api.build()
  decorateExtensionPage(browser)
  const webRequest = browser.webRequest as Record<string, unknown>
  webRequest.filterResponseData = streamFilterUnavailable
  const extension = browser.extension as Record<string, unknown>
  // A background page in its own WebView is not reachable as an object: the
  // answer is null, as Firefox gives where the page is out of reach (private
  // windows), which callers such as Violentmonkey's dashboard take as the cue
  // to use runtime.sendMessage instead. Throwing would break them.
  extension.getBackgroundPage = () => null
  extension.getViews = () => []
  ;(browser.runtime as Record<string, unknown>).getBackgroundPage = () => Promise.resolve(null)
  scope[BRIDGE_STAGING_KEY] = browser
  adoptBridge()
  if (init.kind === "popup" && window === window.top) reportPopupSize(post)
}

bootstrapExtensionPage()
