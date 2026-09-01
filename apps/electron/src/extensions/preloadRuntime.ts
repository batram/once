// The `browser` object builder both preloads share. Everything here runs in
// a sandboxed renderer: listeners live in this file's closures, calls go to
// main through the transport, and events from main are dispatched back to
// the listeners that asked. Ports are built on the same two primitives.

import { getLocaleMessage } from "@once/core"
import {
  ApiSurface,
  EXTENSION_SCHEME,
  ExtensionContextInit,
  ExtensionEvent,
  INTERNAL_API
} from "./protocol"

export type Listener = (...args: unknown[]) => unknown

/** Where a preload parks the bridge copy before the world adopts it. */
export const BRIDGE_STAGING_KEY = "__onceExtensionApi"

/**
 * Runs inside the target world, so it must be self-contained: a
 * `contextBridge` copy is frozen, and extensions (uBlock's `i18n.js` among
 * them) add helpers onto `browser.*` the way Firefox permits. Rebuilding the
 * tree as plain objects keeps the proxied functions and makes every
 * namespace extensible again.
 */
export function adoptBridge(): void {
  const scope = globalThis as unknown as { __onceExtensionApi?: unknown }
  const staged = scope.__onceExtensionApi
  if (!staged) return
  const copy = (value: unknown): unknown => {
    if (typeof value !== "object" || value === null) return value
    const source = value as Record<string, unknown>
    const out: Record<string, unknown> = Array.isArray(value) ? [] as unknown as Record<string, unknown> : {}
    for (const name of Object.keys(source)) out[name] = copy(source[name])
    return out
  }
  const browser = copy(staged)
  Object.defineProperty(globalThis, "browser", {
    value: browser, writable: true, configurable: true, enumerable: false
  })
  // Chromium's own `window.chrome` is replaced by the same object: generic
  // WebExtension builds reach synchronous APIs such as runtime.getURL
  // through `chrome`, and Firefox offers it as an alias too.
  Object.defineProperty(globalThis, "chrome", {
    value: browser, writable: true, configurable: true, enumerable: false
  })
  delete scope.__onceExtensionApi
}

/** `adoptBridge` as a script, for worlds that take code rather than functions. */
export const ADOPT_BRIDGE_SOURCE = `(${adoptBridge.toString()})()`

export interface ApiTransport {
  invoke(api: string, method: string, args: unknown[]): Promise<unknown>
  reply(token: number, result: unknown[]): void
}

interface Registered {
  listener: Listener
  id: number
}

interface PortEnd {
  object: Record<string, unknown>
  onMessage: Set<Listener>
  onDisconnect: Set<Listener>
}

/** An event nothing in main ever raises; listeners are accepted and kept. */
export function localEvent(): { object: Record<string, unknown>; listeners: Set<Listener> } {
  const listeners = new Set<Listener>()
  return {
    listeners,
    object: {
      addListener: (listener: Listener) => {
        listeners.add(listener)
      },
      removeListener: (listener: Listener) => {
        listeners.delete(listener)
      },
      hasListener: (listener: Listener) => listeners.has(listener),
      hasListeners: () => listeners.size > 0
    }
  }
}

function fire(listeners: Set<Listener>, ...args: unknown[]): void {
  for (const listener of [...listeners]) {
    try {
      listener(...args)
    } catch (error) {
      console.error("extension listener failed", error)
    }
  }
}

// runtime.onMessage listeners answer in one of three ways: return a value or
// a promise, return true and call sendResponse later, or call sendResponse
// synchronously. All three end in one settled value.
function runMessageListener(listener: Listener, args: unknown[]): Promise<unknown> {
  return new Promise((resolve) => {
    let settled = false
    const sendResponse = (value?: unknown) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    let result: unknown
    try {
      result = listener(...args, sendResponse)
    } catch (error) {
      console.error("runtime.onMessage listener failed", error)
      sendResponse(undefined)
      return
    }
    if (result && typeof (result as Promise<unknown>).then === "function") {
      (result as Promise<unknown>).then(sendResponse, (error) => {
        console.error("runtime.onMessage listener rejected", error)
        sendResponse(undefined)
      })
    } else if (result !== true && !settled) {
      sendResponse(undefined)
    }
  })
}

export class PreloadApi {
  private readonly listeners = new Map<string, Registered[]>()
  private readonly ports = new Map<number, PortEnd>()
  private nextListenerId = 1

  constructor(
    private readonly init: ExtensionContextInit,
    private readonly surface: Readonly<Record<string, ApiSurface>>,
    private readonly transport: ApiTransport
  ) {}

  getURL(path: unknown): string {
    const relative = typeof path === "string" ? path.replace(/^\/+/, "") : ""
    return `${EXTENSION_SCHEME}://${this.init.host}/${relative}`
  }

  /** The `browser` object with every namespace in the surface. */
  build(): Record<string, unknown> {
    const browser: Record<string, unknown> = {}
    for (const api of Object.keys(this.surface)) this.assign(browser, api, this.namespace(api))

    const runtime = browser.runtime as Record<string, unknown>
    runtime.id = this.init.id
    runtime.getURL = (path: unknown) => this.getURL(path)
    runtime.getManifest = () => this.init.manifest
    runtime.lastError = undefined
    runtime.connect = (first?: unknown, second?: unknown) => {
      const info = typeof first === "object" && first !== null ? first : second
      return this.connect({ name: (info as { name?: unknown } | undefined)?.name })
    }
    if (browser.tabs) {
      (browser.tabs as Record<string, unknown>).connect = (tabId: unknown, info?: unknown) => {
        const record = (info ?? {}) as { name?: unknown; frameId?: unknown }
        return this.connect({ name: record.name, tabId, frameId: record.frameId })
      }
    }

    // Firefox hands back a handle; the id stays on this side of the bridge.
    if (browser.contentScripts) {
      const contentScripts = browser.contentScripts as Record<string, unknown>
      contentScripts.register = async (options: unknown) => {
        const id = await this.transport.invoke("contentScripts", "register", [options])
        return {
          unregister: () => this.transport.invoke("contentScripts", "unregister", [id])
        }
      }
      delete contentScripts.unregister
    }

    const extension = (browser.extension ??= {}) as Record<string, unknown>
    extension.getURL = (path: unknown) => this.getURL(path)
    extension.inIncognitoContext = false

    const i18n = (browser.i18n ??= {}) as Record<string, unknown>
    i18n.getMessage = (key: unknown, substitutions?: unknown) => {
      if (typeof key !== "string") return ""
      const list = substitutions === undefined
        ? []
        : Array.isArray(substitutions) ? substitutions.map(String) : [String(substitutions)]
      return getLocaleMessage(this.init.messages, key, list)
    }
    i18n.getUILanguage = () => this.init.uiLanguage
    return browser
  }

  /** An event from main: run the listeners it names, reply if it asked. */
  handleEvent(message: ExtensionEvent): void {
    if (message.api === INTERNAL_API.port) {
      this.handlePortEvent(message)
      return
    }
    if (message.api === "runtime" && message.event === "onConnect") {
      this.handleConnect(message)
      return
    }
    const registered = this.listeners.get(`${message.api}.${message.event}`) ?? []
    const selected = message.listeners
      ? registered.filter((entry) => message.listeners?.includes(entry.id))
      : registered
    const runs = selected.map((entry) =>
      this.runListener(message.api, message.event, entry.listener, message.args)
    )
    if (message.token === undefined) return
    const token = message.token
    void Promise.all(runs).then((result) => this.transport.reply(token, result))
  }

  private async runListener(api: string, event: string, listener: Listener, args: unknown[]): Promise<unknown> {
    if (api === "runtime" && event === "onMessage") return runMessageListener(listener, args)
    try {
      return await listener(...args)
    } catch (error) {
      console.error(`${api}.${event} listener failed`, error)
      return undefined
    }
  }

  private namespace(api: string): Record<string, unknown> {
    const object: Record<string, unknown> = {}
    for (const name of this.surface[api].methods) {
      object[name] = (...args: unknown[]) => {
        // `chrome` is the same object, so a trailing function is a Chrome
        // style callback rather than an argument for main.
        const callback = typeof args[args.length - 1] === "function"
          ? args.pop() as Listener
          : null
        const result = this.transport.invoke(api, name, args).catch((error) => {
          // Arguments cross to main by structured clone; say which call an
          // extension made with something that cannot.
          if (error instanceof Error && /could not be cloned/.test(error.message)) {
            console.error(`browser.${api}.${name}: an argument is not cloneable`, args)
          }
          throw error
        })
        if (!callback) return result
        result.then(
          (value) => callback(value),
          (error) => {
            console.error(`browser.${api}.${name} failed`, error)
            callback()
          }
        )
        return undefined
      }
    }
    for (const name of this.surface[api].events) object[name] = this.eventObject(api, name)
    return object
  }

  private assign(root: Record<string, unknown>, dotted: string, value: Record<string, unknown>): void {
    const parts = dotted.split(".")
    let target = root
    for (const part of parts.slice(0, -1)) {
      target[part] ??= {}
      target = target[part] as Record<string, unknown>
    }
    const last = parts[parts.length - 1]
    target[last] = { ...(target[last] as Record<string, unknown> | undefined), ...value }
  }

  private eventObject(api: string, event: string): Record<string, unknown> {
    const key = `${api}.${event}`
    return {
      addListener: (listener: Listener, filter?: unknown, extraInfoSpec?: unknown) => {
        if (typeof listener !== "function") return
        const registered = this.listeners.get(key) ?? []
        if (registered.some((entry) => entry.listener === listener)) return
        const id = this.nextListenerId++
        registered.push({ listener, id })
        this.listeners.set(key, registered)
        const spec = api === "webRequest"
          ? { filter, extraInfoSpec: Array.isArray(extraInfoSpec) ? extraInfoSpec : [] }
          : undefined
        void this.transport.invoke(INTERNAL_API.listeners, "add", [{ api, event, id, spec }])
      },
      removeListener: (listener: Listener) => {
        const registered = this.listeners.get(key)
        if (!registered) return
        const index = registered.findIndex((entry) => entry.listener === listener)
        if (index < 0) return
        const [removed] = registered.splice(index, 1)
        void this.transport.invoke(INTERNAL_API.listeners, "remove", [{ api, event, id: removed.id }])
      },
      hasListener: (listener: Listener) =>
        (this.listeners.get(key) ?? []).some((entry) => entry.listener === listener),
      hasListeners: () => (this.listeners.get(key) ?? []).length > 0
    }
  }

  // A port is two ends joined in main. This side keeps the listeners and
  // forwards postMessage; the id arrives once main has found the other end.
  private makePort(name: string, sender: unknown, ready: Promise<number | null>): PortEnd {
    const onMessage = localEvent()
    const onDisconnect = localEvent()
    const end: PortEnd = {
      onMessage: onMessage.listeners,
      onDisconnect: onDisconnect.listeners,
      object: {}
    }
    let closed = false
    const close = () => {
      if (closed) return
      closed = true
      fire(end.onDisconnect, end.object)
      void ready.then((id) => {
        if (id !== null) this.ports.delete(id)
      })
    }
    end.object = {
      name,
      sender,
      error: undefined,
      onMessage: onMessage.object,
      onDisconnect: onDisconnect.object,
      postMessage: (message: unknown) => {
        void ready.then((id) => {
          if (id === null || closed) return
          void this.transport.invoke(INTERNAL_API.port, "post", [{ portId: id, message }])
        })
      },
      disconnect: () => {
        void ready.then((id) => {
          if (id !== null) void this.transport.invoke(INTERNAL_API.port, "disconnect", [{ portId: id }])
        })
        close()
      }
    }
    void ready.then((id) => {
      if (id === null) close()
      else if (!closed) this.ports.set(id, end)
    })
    return end
  }

  private connect(options: { name?: unknown; tabId?: unknown; frameId?: unknown }): Record<string, unknown> {
    const name = typeof options.name === "string" ? options.name : ""
    const ready = this.transport.invoke(INTERNAL_API.port, "connect", [{
      name,
      tabId: typeof options.tabId === "number" ? options.tabId : undefined,
      frameId: typeof options.frameId === "number" ? options.frameId : undefined
    }]).then(
      (id) => (typeof id === "number" ? id : null),
      () => null
    )
    return this.makePort(name, undefined, ready).object
  }

  private handleConnect(message: ExtensionEvent): void {
    const [details] = message.args as [{ portId: number; name: string; sender: unknown }]
    const listeners = this.listeners.get("runtime.onConnect") ?? []
    if (listeners.length === 0) {
      void this.transport.invoke(INTERNAL_API.port, "disconnect", [{ portId: details.portId }])
      return
    }
    const end = this.makePort(details.name, details.sender, Promise.resolve(details.portId))
    for (const entry of listeners) {
      try {
        entry.listener(end.object)
      } catch (error) {
        console.error("runtime.onConnect listener failed", error)
      }
    }
  }

  private handlePortEvent(message: ExtensionEvent): void {
    const [details] = message.args as [{ portId: number; message?: unknown }]
    const end = this.ports.get(details.portId)
    if (!end) return
    if (message.event === "message") {
      fire(end.onMessage, details.message, end.object)
    } else if (message.event === "disconnect") {
      this.ports.delete(details.portId)
      fire(end.onDisconnect, end.object)
    }
  }
}
