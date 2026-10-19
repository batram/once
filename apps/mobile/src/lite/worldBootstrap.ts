// The content-world bootstrap. Installed by Java with
// `Page.addScriptToEvaluateOnNewDocument` in world `once-ext:<host>` of every
// tab target, followed by `__onceLiteWorldBoot(config)` with the extension's
// identity and all of its content scripts. It mirrors Electron's
// contentPreload: `browser` over the binding transport, matching against
// `location`, scheduling at document_start/end/idle, author-origin styles,
// the injection events, and a `wrappedJSObject` proxy. Differences: the
// matcher runs here rather than in main, scriptlets need the document nonce
// (or main-world evaluation under a `<meta>` policy), and `wrappedJSObject`
// carries JSON values only.

import {
  ADOPT_BRIDGE_SOURCE,
  BRIDGE_STAGING_KEY,
  CONTENT_API_SURFACE,
  EXTENSION_API_SURFACE,
  ExtensionEvent,
  INTERNAL_API,
  PreloadApi,
  decorateExtensionPage,
  unwrapInvoke
} from "@once/webext-runtime/preload"
import { sha256Hex } from "@once/webext-runtime"
import { MatchPatternSet } from "@once/core"
import { BLOB_PATH, BrokerToWorldMessage, WORLD_BINDING, WORLD_DELIVER, WorldConfig, WorldDynamicConfig, WorldScript, WorldToBrokerMessage, dynamicAnswerPath, pageHostOf, pageOrigin, pageUrlFromExtensionUrl } from "./protocol"

type Scope = typeof globalThis & Record<string, unknown>

interface World {
  config: WorldConfig
  api: PreloadApi
  styles: Map<string, HTMLStyleElement>
  frame: { url: string; topUrl: string; isTop: boolean }
  scripts: PageScripts | null
  send(message: WorldToBrokerMessage): void
  /** Undoes the prototype patches; for tests that boot several worlds in one document. */
  dispose(): void
}

/** Where the booted world is kept on the global, so a second boot in the same context is a no-op. */
const WORLD_KEY = "__onceLiteWorld"

/** The event the main-world helper answers synchronously, scoped by the token. */
export function accessEventName(token: string): string {
  return `once-lite:${token}:access`
}

export function accessAttribute(token: string): string {
  return `data-once-lite-${token.slice(0, 16)}`
}

/** The nonce the broker added to this document's policy; the same derivation as `documentNonce`. */
export function worldNonce(token: string, href: string): string {
  let canonical = href
  try {
    const url = new URL(href)
    url.hash = ""
    canonical = url.href
  } catch { /* opaque */ }
  return sha256Hex(`${token}|${canonical}`).slice(0, 32)
}

function blank(url: string): boolean {
  return url === "about:blank" || url === "" || url === "about:srcdoc"
}

function policyUrl(): string {
  // A blank frame inherits its parent's policy (and so its nonce).
  if (!blank(location.href)) return location.href
  try {
    return window.parent.location.href
  } catch {
    return location.href
  }
}

function frameIdentity(): { url: string; topUrl: string; isTop: boolean; creatorUrl: string } {
  const isTop = window === window.top
  let topUrl = location.href
  try {
    topUrl = window.top?.location.href ?? location.href
  } catch { /* cross-origin top: its URL is not readable here */ }
  let creatorUrl = ""
  try {
    let ancestor: Window = window
    while (ancestor !== ancestor.parent) {
      ancestor = ancestor.parent
      if (!blank(ancestor.location.href)) { creatorUrl = ancestor.location.href; break }
    }
  } catch { /* cross-origin ancestor */ }
  return { url: location.href, topUrl, isTop, creatorUrl }
}

/** Which of the extension's scripts apply here; the same rules as `contentScriptsFor`. */
export function selectScripts(scripts: readonly WorldScript[], frame: { url: string; topUrl: string; isTop: boolean }): WorldScript[] {
  const isBlank = blank(frame.url)
  return scripts.filter((script) => {
    if (!frame.isTop && !script.allFrames) return false
    let subject = frame.url
    if (isBlank) {
      if (!script.matchAboutBlank) return false
      subject = frame.topUrl
    }
    return new MatchPatternSet(script.matches).matches(subject) && !new MatchPatternSet(script.excludeMatches).matches(subject)
  })
}

function whenDocumentStart(run: () => void): void {
  if (document.documentElement) { run(); return }
  const observer = new MutationObserver(() => {
    if (!document.documentElement) return
    observer.disconnect()
    run()
  })
  observer.observe(document, { childList: true })
}

function whenDocumentEnd(run: () => void): void {
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", run, { once: true })
  else run()
}

function whenDocumentIdle(run: () => void): void {
  if (document.readyState === "complete") setTimeout(run, 0)
  else window.addEventListener("load", () => setTimeout(run, 0), { once: true })
}

// Scripts the world hands to the page: a `<script>` with the document nonce
// runs under a header policy; under a `<meta>`-only policy the probe fails
// and the broker evaluates them in the main world instead.
class PageScripts {
  private nonceWorks: boolean | null = null
  readonly nonce: string

  constructor(private readonly world: World) {
    this.nonce = worldNonce(world.config.token, policyUrl())
  }

  private probing = false

  private probe(): boolean {
    if (this.nonceWorks !== null) return this.nonceWorks
    const root = document.documentElement
    // The probe's own insertion goes through the patched methods below.
    if (!root || this.probing) return true
    this.probing = true
    const marker = `data-once-lite-probe-${this.nonce.slice(0, 8)}`
    const script = document.createElement("script")
    script.nonce = this.nonce
    script.textContent = `document.documentElement.setAttribute(${JSON.stringify(marker)}, "1")`
    root.appendChild(script)
    script.remove()
    this.probing = false
    this.nonceWorks = root.hasAttribute(marker)
    root.removeAttribute(marker)
    return this.nonceWorks
  }

  run(code: string, url?: string): void {
    const text = url ? `${code}\n//# sourceURL=${url}` : code
    if (this.probe()) {
      const script = document.createElement("script")
      script.nonce = this.nonce
      script.textContent = text
      ;(document.documentElement ?? document).appendChild(script)
      script.remove()
    } else {
      this.world.send({ host: this.world.config.init.host, type: "main-eval", code: text })
    }
  }

  /** The extension's own `<script>` insertions (uBlock's scriptlet injector) get the nonce too. */
  patchDocument(): () => void {
    const nonce = this.nonce
    const Script = HTMLScriptElement
    const documentProto = owningPrototype(document, "createElement") as typeof Document.prototype
    const create = documentProto.createElement
    const restores: (() => void)[] = [() => { documentProto.createElement = create }]
    documentProto.createElement = function (this: Document, name: string, options?: ElementCreationOptions) {
      const element = create.call(this, name, options)
      if (element instanceof Script) element.nonce = nonce
      return element
    } as typeof Document.prototype.createElement
    const nsProto = owningPrototype(document, "createElementNS") as typeof Document.prototype
    const createNS = nsProto.createElementNS
    if (typeof createNS === "function") {
      restores.push(() => { nsProto.createElementNS = createNS })
      nsProto.createElementNS = function (this: Document, ...args: unknown[]) {
        const element = (createNS as (...rest: unknown[]) => Element).apply(this, args)
        if (element instanceof Script) element.nonce = nonce
        return element
      } as typeof Document.prototype.createElementNS
    }
    const probe = (): boolean => this.probe()
    const evaluateInMain = (code: string): void =>
      this.world.send({ host: this.world.config.init.host, type: "main-eval", code })
    const nodeProto = owningPrototype(document.documentElement ?? document, "appendChild") as typeof Node.prototype
    for (const method of ["appendChild", "insertBefore"] as const) {
      const original = nodeProto[method] as (...args: Node[]) => Node
      restores.push(() => { nodeProto[method] = original as never })
      nodeProto[method] = function (this: Node, ...args: Node[]) {
        const node = args[0]
        if (node instanceof Script && !node.src && node.textContent && !probe()) {
          evaluateInMain(node.textContent)
          node.type = "text/once-lite-evaluated"
        }
        return original.apply(this, args)
      } as never
    }
    return () => { for (const restore of restores.reverse()) restore() }
  }
}

/** The prototype in `object`'s chain that defines `method` (Chrome: `Document.prototype`, `Node.prototype`). */
function owningPrototype(object: object, method: string): object {
  let current: object | null = Object.getPrototypeOf(object)
  while (current && !Object.prototype.hasOwnProperty.call(current, method)) current = Object.getPrototypeOf(current)
  return current ?? Object.getPrototypeOf(object)
}

function insertStyle(world: World, css: string): void {
  if (world.styles.has(css)) return
  const style = document.createElement("style")
  style.textContent = css
  ;(document.head ?? document.documentElement ?? document).appendChild(style)
  world.styles.set(css, style)
}

function removeStyle(world: World, css: string): void {
  world.styles.get(css)?.remove()
  world.styles.delete(css)
}

/**
 * A content script runs with a sandbox object as `this`, as in Firefox,
 * rather than the world's global: Violentmonkey hands `this` to userscripts
 * as `unsafeWindow`, and a page global must be readable through it while it
 * stays distinct from the world's `window`. The sandbox forwards to the
 * world's global (with the global as receiver, since the window's accessors
 * refuse any other, and methods bound to it); a name the world does not
 * have is read from the page through `wrappedJSObject`. Its `window`, `self`,
 * `top` and the like are the sandbox itself, so Violentmonkey's browser
 * detection (`this !== this.window` means Firefox) keeps it on its Chrome
 * path, whose page bridge works without xray wrappers. Bare names still
 * resolve to the world's globals through the scope chain.
 */
const SANDBOX_KEY = "__onceLiteSandbox"

function sandbox(scope: Scope): object {
  const existing = scope[SANDBOX_KEY] as object | undefined
  if (existing) return existing
  const bound = new WeakMap<object, unknown>()
  // Only the global's native methods are bound: a script's own function must
  // stay itself (Violentmonkey stringifies its bridge into the page).
  const forward = (value: unknown): unknown => {
    if (value === scope) return box
    if (typeof value !== "function" || Object.prototype.hasOwnProperty.call(value, "prototype")) return value
    if (!Function.prototype.toString.call(value).includes("[native code]")) return value
    let method = bound.get(value)
    if (!method) {
      method = (value as (...args: unknown[]) => unknown).bind(scope)
      bound.set(value, method)
    }
    return method
  }
  const box: object = new Proxy(Object.create(null) as object, {
    get: (_target, key) => {
      if (key === SANDBOX_KEY) return box
      if (key in scope) return forward(Reflect.get(scope, key, scope))
      const page = scope.wrappedJSObject as Record<string | symbol, unknown> | undefined
      return typeof key === "string" && page ? page[key] : undefined
    },
    set: (_target, key, value) => Reflect.set(scope, key, value, scope),
    has: (_target, key) => key in scope,
    deleteProperty: (_target, key) => Reflect.deleteProperty(scope, key),
    // A non-configurable definition is mirrored on the target: proxies may
    // only report such properties when the target holds them.
    defineProperty: (target, key, descriptor) => {
      if (!Reflect.defineProperty(scope, key, descriptor)) return false
      if (descriptor.configurable === false) Reflect.defineProperty(target, key, descriptor)
      return true
    },
    getPrototypeOf: () => Object.getPrototypeOf(scope) as object | null,
    preventExtensions: () => false,
    ownKeys: () => Reflect.ownKeys(scope),
    getOwnPropertyDescriptor: (target, key) => {
      const found = Reflect.getOwnPropertyDescriptor(scope, key)
      if (!found) return undefined
      const mirrored = Reflect.getOwnPropertyDescriptor(target, key)
      const descriptor = { ...found, configurable: !(mirrored && mirrored.configurable === false) }
      // Descriptors hand out the global's accessors and methods bound the same way.
      if ("value" in descriptor) descriptor.value = forward(descriptor.value)
      if (descriptor.get) descriptor.get = forward(descriptor.get) as () => unknown
      if (descriptor.set) descriptor.set = forward(descriptor.set) as (value: unknown) => void
      return descriptor
    }
  })
  Object.defineProperty(scope, SANDBOX_KEY, { value: box, writable: false, configurable: true, enumerable: false })
  return box
}

// A direct eval inside a sloppy function (the bundle itself is strict, and a
// userscript may use `with`) keeps that function's `this` and still yields
// the script's completion value, which `tabs.executeScript` answers.
const runInSandbox = new Function("text", "return eval(text)") as (this: object, text: string) => unknown

function runIsolated(code: string, url: string | undefined): unknown {
  return runInSandbox.call(sandbox(globalThis as Scope), url ? `${code}\n//# sourceURL=${url}` : code)
}

function runBatch(world: World, scripts: PageScripts, batch: WorldScript[]): void {
  for (const script of batch) {
    for (const css of script.css) insertStyle(world, css)
    for (const entry of script.js) {
      try {
        if (script.world === "MAIN") scripts.run(entry.code, entry.url)
        else runIsolated(entry.code, entry.url)
      } catch (error) {
        console.error(`[${world.config.init.id}] content script failed`, entry.url, error)
      }
    }
  }
}

function schedule(world: World, scripts: PageScripts, selected: WorldScript[]): void {
  const phases = { document_start: whenDocumentStart, document_end: whenDocumentEnd, document_idle: whenDocumentIdle }
  for (const runAt of ["document_start", "document_end", "document_idle"] as const) {
    const batch = selected.filter((script) => script.runAt === runAt)
    if (batch.length > 0) phases[runAt](() => runBatch(world, scripts, batch))
  }
}

function handleInjection(world: World, scripts: PageScripts, message: ExtensionEvent): void {
  const [details] = message.args as [{ code?: string; url?: string; css?: string; world?: string }]
  if (message.event === "insertCSS" && typeof details.css === "string") {
    insertStyle(world, details.css)
  } else if (message.event === "removeCSS" && typeof details.css === "string") {
    removeStyle(world, details.css)
  } else if (message.event === "executeScript" && typeof details.code === "string") {
    let result: unknown
    try {
      if (details.world === "MAIN") scripts.run(details.code, details.url)
      else result = runIsolated(details.code, details.url)
    } catch (error) {
      console.error(`[${world.config.init.id}] executeScript failed`, error)
    }
    if (message.token !== undefined) {
      let value: unknown
      try { value = JSON.parse(JSON.stringify(result ?? null)) } catch { value = null }
      world.send({ host: world.config.init.host, type: "reply", token: message.token, result: [value] })
    }
  }
}

/** `wrappedJSObject`: synchronous main-world reads through the helper's event channel. */
function defineWrappedJSObject(scope: Scope, token: string): void {
  const event = accessEventName(token)
  const attribute = accessAttribute(token)
  const ask = (op: "get" | "has" | "delete", name: string): unknown => {
    const root = document.documentElement
    if (!root) return undefined
    document.dispatchEvent(new CustomEvent(event, { detail: JSON.stringify({ op, name }) }))
    const answer = root.getAttribute(attribute)
    root.removeAttribute(attribute)
    if (answer === null) return undefined
    try { return JSON.parse(answer) } catch { return undefined }
  }
  const wrapped = new Proxy({}, {
    get: (_target, name) => (typeof name === "string" ? ask("get", name) : undefined),
    has: (_target, name) => typeof name === "string" && ask("has", name) === true,
    deleteProperty: (_target, name) => {
      if (typeof name === "string") ask("delete", name)
      return true
    }
  })
  Object.defineProperty(scope, "wrappedJSObject", { value: wrapped, writable: true, configurable: true, enumerable: false })
  // Firefox's xray helpers: there is no membrane here, so a function or object is its own export.
  if (typeof scope.exportFunction !== "function") scope.exportFunction = (fn: unknown) => fn
  if (typeof scope.cloneInto !== "function") scope.cloneInto = (value: unknown) => value
}

/**
 * A `blob:` URL of the extension's origin (Violentmonkey's synchronous
 * injection hands the content script one) cannot be read from the page's
 * origin; it is requested as `<page origin>/_once/blob/<id>`, which the
 * broker answers through the extension's background page. Both URL forms of
 * the origin are recognised.
 */
export function mapBlobUrl(host: string, url: string): string {
  const origin = pageOrigin(host)
  for (const prefix of [`blob:${origin}/`, `blob:moz-extension://${host}/`]) {
    if (url.startsWith(prefix)) return `${origin}${BLOB_PATH}${url.slice(prefix.length)}`
  }
  return url
}

function patchBlobRequests(scope: Scope, host: string): void {
  const Xhr = scope.XMLHttpRequest as typeof XMLHttpRequest | undefined
  if (Xhr) {
    const open = Xhr.prototype.open
    Xhr.prototype.open = function (this: XMLHttpRequest, method: string, url: string | URL, ...rest: unknown[]) {
      return (open as (...args: unknown[]) => void).call(this, method, mapBlobUrl(host, String(url)), ...rest)
    } as typeof open
  }
  const originalFetch = scope.fetch as typeof fetch | undefined
  if (originalFetch) {
    scope.fetch = ((input: RequestInfo | URL, init?: RequestInit) =>
      originalFetch.call(scope, typeof input === "string" ? mapBlobUrl(host, input) : input, init)) as typeof fetch
  }
}

/**
 * The extension's scripts registered at run time, asked for synchronously
 * at document start so they run before the page's own scripts (uBlock's
 * scriptlets are registered during the document's held onResponseStarted).
 * The request never leaves the device: the broker answers it at the Fetch
 * request stage. Nothing, or an empty list, when it cannot be asked.
 */
export function fetchDynamicScripts(host: string, scope: Scope): WorldDynamicConfig | null {
  const Xhr = scope.XMLHttpRequest as typeof XMLHttpRequest | undefined
  // Only documents with a URL to match: a blank one (the tab's marker page,
  // a frame yet to navigate) would block its renderer while the target is
  // still being set up.
  if (!Xhr || !/^https?:/.test(location.href)) return null
  try {
    const request = new Xhr()
    request.open("GET", `${pageOrigin(host)}${dynamicAnswerPath(location.href)}`, false)
    request.send()
    if (request.status !== 200) return null
    const config = JSON.parse(request.responseText) as WorldDynamicConfig
    return config && config.host === host && Array.isArray(config.scripts) ? config : null
  } catch {
    return null
  }
}

/** Registered scripts for the booted world: matched and scheduled like the manifest's. */
export function addDynamicScripts(config: WorldDynamicConfig, scope: Scope = globalThis as Scope): void {
  const world = scope[WORLD_KEY] as World | undefined
  if (!world || world.config.init.host !== config.host || !world.scripts) return
  if (typeof config.cookie === "string" && config.cookie) {
    try { document.cookie = `${config.cookie}; SameSite=Lax; path=/` } catch { /* a cookie-less document */ }
  }
  schedule(world, world.scripts, selectScripts(config.scripts, world.frame))
}

export function bootWorld(config: WorldConfig, scope: Scope = globalThis as Scope): World | null {
  const binding = scope[WORLD_BINDING] as ((payload: string) => void) | undefined
  if (typeof binding !== "function") return null
  // Installed again on a live document: the first boot's listeners and ports stay.
  if (scope[WORLD_KEY]) return scope[WORLD_KEY] as World
  const host = config.init.host
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  let nextId = 1
  const send = (message: WorldToBrokerMessage): void => binding(JSON.stringify(message))
  const frame = frameIdentity()
  const ownPage = pageHostOf(frame.url) === host
  const api = new PreloadApi({ ...config.init, kind: ownPage ? "page" : "content" }, ownPage ? EXTENSION_API_SURFACE : CONTENT_API_SURFACE, {
    invoke: (namespace, method, args) => new Promise((resolve, reject) => {
      const id = nextId++
      pending.set(id, { resolve, reject })
      try {
        send({ host, type: "invoke", id, api: namespace, method, args })
      } catch {
        pending.delete(id)
        reject(new Error(`browser.${namespace}.${method}: an argument could not be cloned`))
      }
    }),
    reply: (token, result) => send({ host, type: "reply", token, result }),
    listen: (change) => send({ host, type: "listen", change })
  })
  const world: World = { config, api, styles: new Map(), frame, scripts: null, send, dispose: () => undefined }
  scope[WORLD_KEY] = world
  const scripts = new PageScripts(world)
  world.scripts = scripts
  scope[WORLD_DELIVER] = (json: string) => {
    let message: BrokerToWorldMessage
    try { message = JSON.parse(json) } catch { return }
    if (message.type === "result") {
      const waiting = pending.get(message.id)
      if (!waiting) return
      pending.delete(message.id)
      try { waiting.resolve(unwrapInvoke(message.result)) } catch (error) { waiting.reject(error as Error) }
    } else if (message.type === "event") {
      if (message.message.api === INTERNAL_API.content) handleInjection(world, scripts, message.message)
      else api.handleEvent(message.message)
    }
  }
  const browser = api.build()
  if (ownPage) decorateExtensionPage(browser)
  // URLs a content script puts into the DOM must load: the https form.
  const getURL = (path: unknown): string => pageUrlFromExtensionUrl(api.getURL(path))
  ;(browser.runtime as Record<string, unknown>).getURL = getURL
  ;(browser.extension as Record<string, unknown>).getURL = getURL
  scope[BRIDGE_STAGING_KEY] = browser
  ;(0, eval)(ADOPT_BRIDGE_SOURCE)
  const selected = ownPage ? [] : selectScripts(config.scripts, frame)
  send({ host, type: "hello", url: frame.url, topUrl: frame.topUrl, creatorUrl: frame.creatorUrl, matched: selected.length > 0 })
  if (ownPage) return world
  patchBlobRequests(scope, host)
  defineWrappedJSObject(scope, config.token)
  const undo = scripts.patchDocument()
  world.dispose = () => {
    undo()
    Reflect.deleteProperty(scope, WORLD_KEY)
  }
  schedule(world, scripts, selected)
  const dynamic = fetchDynamicScripts(host, scope)
  if (dynamic) addDynamicScripts(dynamic, scope)
  return world
}

;(globalThis as Scope).__onceLiteWorldBoot = (config: WorldConfig) => bootWorld(config)
