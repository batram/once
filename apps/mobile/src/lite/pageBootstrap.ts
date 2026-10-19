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
import { BrokerToPageMessage, PAGE_CHANNEL, PageToBrokerMessage } from "./protocol"

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
  const post = (message: PageToBrokerMessage): void => port.postMessage(JSON.stringify(message))
  const api = new PreloadApi(init, EXTENSION_API_SURFACE, {
    invoke: (namespace, method, args) => new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      let encoded: string
      try {
        encoded = JSON.stringify({ type: "invoke", id, api: namespace, method, args })
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
      api.handleEvent(message.message)
    }
  }
  const browser = api.build()
  decorateExtensionPage(browser)
  const webRequest = browser.webRequest as Record<string, unknown>
  webRequest.filterResponseData = streamFilterUnavailable
  const extension = browser.extension as Record<string, unknown>
  // A background page in its own WebView is not reachable as an object.
  extension.getBackgroundPage = () => {
    throw new Error("extension.getBackgroundPage is not available on Once Lite: the background page runs in its own WebView; use runtime.sendMessage")
  }
  extension.getViews = () => []
  ;(browser.runtime as Record<string, unknown>).getBackgroundPage = () =>
    Promise.reject(new Error("runtime.getBackgroundPage is not available on Once Lite; use runtime.sendMessage"))
  scope[BRIDGE_STAGING_KEY] = browser
  adoptBridge()
  if (init.kind === "popup" && window === window.top) reportPopupSize(post)
}

bootstrapExtensionPage()
