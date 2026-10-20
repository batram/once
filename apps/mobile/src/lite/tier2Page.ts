// `lite-tier2-page.js`: the userscript runtime Tier 2 (no DevTools,
// docs/plans/once-lite-plan.md) runs in every document of a reading tab.
// Java registers each source the broker builds (`tier2.scripts`) with
// `addDocumentStartJavaScript` in the page world (or `addJavaScriptOnEvent`
// in an isolated world where the WebView supports it), in order:
//
// 1. this bundle as `(function () { const ONCE_TIER2 = {kind: "runtime", key}; <bundle> })();`,
//    which leaves the runtime under a per-push random, non-enumerable key on
//    `window` for the sources after it;
// 2. one source per synced userscript, `window[key].userscript(info, run)`:
//    matched here with @once/core's `UserscriptMatcher` against `location`
//    and run at its `@run-at` with the closure-scoped GM shim iOS gives
//    userscripts; each is its own registration, so one that does not parse
//    costs only itself;
// 3. a last source deleting the key before any page script runs.
//
// GM shim limits (as on iOS): values live in the page origin's
// `localStorage` under `once.userscript.<id>.`, so pages of that origin can
// read them; `GM_xmlhttpRequest` is `fetch` and same-origin only;
// `unsafeWindow` is the page's `window`; `@require`, `@resource`, menus and
// tabs are not available.

import { UserscriptMatcher, UserscriptMetadata, UserscriptRunAt } from "@once/core"

export interface Tier2ScriptInfo {
  id: string
  name: string
  version: string | null
  namespace: string | null
  matches: string[]
  includes: string[]
  excludes: string[]
  runAt: UserscriptRunAt
  noFrames: boolean
  grants: string[]
}

export interface GmApi {
  GM_addStyle(css: string): HTMLStyleElement
  GM_getValue(key: string, fallback?: unknown): unknown
  GM_setValue(key: string, value: unknown): void
  GM_deleteValue(key: string): void
  GM_listValues(): string[]
  GM_xmlhttpRequest(details: GmRequest): { abort(): void }
  GM_info: { script: { name: string; namespace: string | null; version: string | null }; scriptHandler: string; version: string }
  unsafeWindow: Window
  GM: Record<string, unknown>
}

export interface GmRequest {
  url: string
  method?: string
  headers?: Record<string, string>
  data?: BodyInit
  responseType?: "text" | "json" | "blob" | "arraybuffer"
  onload?(response: unknown): void
  onerror?(response: unknown): void
}

export interface Tier2PageConfig {
  kind: "runtime"
  /** Where the runtime waits for the userscript sources; deleted after them. */
  key: string
}

export interface Tier2Runtime {
  userscript(script: Tier2ScriptInfo, run: (gm: GmApi) => void): void
}

declare const ONCE_TIER2: Tier2PageConfig | undefined

const PREFIX = "once.userscript."

function storage(): Storage | null {
  try {
    return window.localStorage
  } catch {
    return null
  }
}

function insertStyle(css: string): HTMLStyleElement {
  const style = document.createElement("style")
  style.textContent = css
  ;(document.head ?? document.documentElement).append(style)
  return style
}

/** The closure-scoped GM API of one script. */
export function gmApi(script: Tier2ScriptInfo): GmApi {
  const prefix = `${PREFIX}${script.id}.`
  const getValue = (key: string, fallback?: unknown): unknown => {
    const stored = storage()?.getItem(prefix + key) ?? null
    if (stored === null) return fallback
    try {
      return JSON.parse(stored)
    } catch {
      return fallback
    }
  }
  const setValue = (key: string, value: unknown): void => {
    try {
      storage()?.setItem(prefix + key, JSON.stringify(value))
    } catch {
      // Quota or a refused origin: the value is not kept, as when a page clears it.
    }
  }
  const deleteValue = (key: string): void => storage()?.removeItem(prefix + key)
  const listValues = (): string[] => {
    const store = storage()
    if (!store) return []
    const keys: string[] = []
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index)
      if (key?.startsWith(prefix)) keys.push(key.slice(prefix.length))
    }
    return keys
  }
  const request = (details: GmRequest): { abort(): void } => {
    const controller = new AbortController()
    const fail = (error: unknown) => details.onerror?.({ error: String(error), status: 0, finalUrl: details.url })
    let target: URL
    try {
      target = new URL(details.url, location.href)
    } catch (error) {
      fail(error)
      return { abort: () => controller.abort() }
    }
    if (target.origin !== location.origin) {
      fail(new Error("GM_xmlhttpRequest is same-origin only in Once Lite's limited mode"))
      return { abort: () => controller.abort() }
    }
    fetch(target.href, { method: details.method ?? "GET", headers: details.headers, body: details.data, signal: controller.signal, credentials: "include" })
      .then(async (response) => {
        const text = details.responseType === "blob" || details.responseType === "arraybuffer" ? "" : await response.clone().text()
        const body = details.responseType === "blob" ? await response.blob()
          : details.responseType === "arraybuffer" ? await response.arrayBuffer()
            : details.responseType === "json" ? JSON.parse(text) : text
        const headers = [...response.headers.entries()].map(([name, value]) => `${name}: ${value}`).join("\r\n")
        details.onload?.({ status: response.status, statusText: response.statusText, responseText: text, response: body,
          responseHeaders: headers, finalUrl: response.url, readyState: 4 })
      }, fail)
    return { abort: () => controller.abort() }
  }
  const info = { script: { name: script.name, namespace: script.namespace, version: script.version }, scriptHandler: "Once", version: "1" }
  return {
    GM_addStyle: insertStyle,
    GM_getValue: getValue,
    GM_setValue: setValue,
    GM_deleteValue: deleteValue,
    GM_listValues: listValues,
    GM_xmlhttpRequest: request,
    GM_info: info,
    unsafeWindow: window,
    GM: {
      info,
      addStyle: async (css: string) => insertStyle(css),
      getValue: async (key: string, fallback?: unknown) => getValue(key, fallback),
      setValue: async (key: string, value: unknown) => setValue(key, value),
      deleteValue: async (key: string) => deleteValue(key),
      listValues: async () => listValues(),
      xmlHttpRequest: request
    }
  }
}

/** Whether the script runs in this document: frames, `@exclude`, `@match`/`@include`. */
export function scriptMatches(script: Tier2ScriptInfo, href: string, topFrame: boolean): boolean {
  if (script.noFrames && !topFrame) return false
  let url: URL
  try {
    url = new URL(href)
  } catch {
    return false
  }
  const metadata = { matches: script.matches, includes: script.includes, excludes: script.excludes } as unknown as UserscriptMetadata
  try {
    return new UserscriptMatcher(metadata).matchesUrl(url)
  } catch {
    return false
  }
}

/** Calls `run` at the `@run-at` point of this document. */
export function schedule(runAt: UserscriptRunAt, run: () => void): void {
  if (runAt === "document-start") {
    run()
    return
  }
  const ready = () => (runAt === "document-idle" ? setTimeout(run, 0) : run())
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", ready, { once: true })
  else ready()
}

/** Matches and schedules one userscript in this document. */
export function runUserscript(script: Tier2ScriptInfo, run: (gm: GmApi) => void): void {
  let topFrame = true
  try {
    topFrame = window.top === window
  } catch {
    topFrame = false
  }
  if (!scriptMatches(script, location.href, topFrame)) return
  schedule(script.runAt, () => {
    try {
      run(gmApi(script))
    } catch (error) {
      console.error(`Once userscript ${script.name} failed`, error)
    }
  })
}

function boot(config: Tier2PageConfig): void {
  if (config.kind !== "runtime" || !config.key) return
  const runtime: Tier2Runtime = { userscript: runUserscript }
  Object.defineProperty(window, config.key, { value: runtime, configurable: true, enumerable: false, writable: false })
}

if (typeof ONCE_TIER2 === "object" && ONCE_TIER2 !== null) boot(ONCE_TIER2)
