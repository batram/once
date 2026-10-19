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
import { BrokerToWorldMessage, WORLD_BINDING, WORLD_DELIVER, WorldConfig, WorldScript, WorldToBrokerMessage, pageHostOf, pageUrlFromExtensionUrl } from "./protocol"

type Scope = typeof globalThis & Record<string, unknown>

interface World {
  config: WorldConfig
  api: PreloadApi
  styles: Map<string, HTMLStyleElement>
  send(message: WorldToBrokerMessage): void
  /** Undoes the prototype patches; for tests that boot several worlds in one document. */
  dispose(): void
}

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

function runIsolated(code: string, url: string | undefined): unknown {
  return (0, eval)(url ? `${code}\n//# sourceURL=${url}` : code)
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
}

export function bootWorld(config: WorldConfig, scope: Scope = globalThis as Scope): World | null {
  const binding = scope[WORLD_BINDING] as ((payload: string) => void) | undefined
  if (typeof binding !== "function") return null
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
  const world: World = { config, api, styles: new Map(), send, dispose: () => undefined }
  const scripts = new PageScripts(world)
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
  defineWrappedJSObject(scope, config.token)
  world.dispose = scripts.patchDocument()
  schedule(world, scripts, selected)
  return world
}

;(globalThis as Scope).__onceLiteWorldBoot = (config: WorldConfig) => bootWorld(config)
