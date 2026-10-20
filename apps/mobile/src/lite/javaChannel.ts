// The broker's end of the WebMessage channel to Java: requests answered by
// id in both directions, plus events. Java injects a `WebMessageListener`
// object (`window.onceLite`) with `postMessage(string)` and an assignable
// `onmessage`; tests hand in a fake with the same two members.

import { Envelope, LogParams, RequestEnvelope, ResponseEnvelope, TimerFiredParams } from "./protocol"

/** What `WebViewCompat.addWebMessageListener` exposes to the page. */
export interface MessagePort {
  postMessage(message: string): void
  onmessage: ((event: { data: string }) => void) | null
}

export type RequestHandler = (params: unknown) => unknown
export type EventHandler = (params: unknown) => void

export class RequestError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message)
  }
}

export class JavaChannel {
  private readonly pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void }>()
  private readonly requestHandlers = new Map<string, RequestHandler>()
  private readonly eventHandlers = new Map<string, EventHandler[]>()
  private nextId = 1

  constructor(private readonly port: MessagePort) {
    port.onmessage = (event) => this.receive(event.data)
  }

  /** Answers a Java request; the handler's value or thrown error travels back. */
  onRequest(method: string, handler: RequestHandler): void {
    this.requestHandlers.set(method, handler)
  }

  onEvent(event: string, handler: EventHandler): void {
    const handlers = this.eventHandlers.get(event) ?? []
    handlers.push(handler)
    this.eventHandlers.set(event, handlers)
  }

  request<T = unknown>(method: string, params?: unknown): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const id = this.nextId++
      this.pending.set(id, { resolve: (value) => resolve(value as T), reject })
      this.post({ type: "request", id, method, params })
    })
  }

  event(event: string, params?: unknown): void {
    this.post({ type: "event", event, params })
  }

  log(level: LogParams["level"], message: string): void {
    this.event("log", { level, message } satisfies LogParams)
  }

  private post(envelope: Envelope): void {
    this.port.postMessage(JSON.stringify(envelope))
  }

  private receive(data: string): void {
    let envelope: Envelope
    try {
      envelope = JSON.parse(data)
    } catch {
      this.log("error", `Unparseable message from Java: ${data.slice(0, 200)}`)
      return
    }
    if (envelope.type === "response") this.settle(envelope)
    else if (envelope.type === "request") void this.answer(envelope)
    else if (envelope.type === "event") this.dispatch(envelope.event, envelope.params)
  }

  private settle(envelope: ResponseEnvelope): void {
    const pending = this.pending.get(envelope.id)
    if (!pending) return
    this.pending.delete(envelope.id)
    if (envelope.error !== undefined) pending.reject(new RequestError(envelope.error, envelope.code))
    else pending.resolve(envelope.result)
  }

  private async answer(envelope: RequestEnvelope): Promise<void> {
    const handler = this.requestHandlers.get(envelope.method)
    let response: ResponseEnvelope
    try {
      if (!handler) throw new Error(`Unknown broker method ${envelope.method}`)
      response = { type: "response", id: envelope.id, result: await handler(envelope.params) ?? null }
    } catch (error) {
      response = {
        type: "response", id: envelope.id,
        error: error instanceof Error ? error.message : String(error),
        code: error instanceof RequestError ? error.code : undefined
      }
    }
    this.post(response)
  }

  private dispatch(event: string, params: unknown): void {
    for (const handler of this.eventHandlers.get(event) ?? []) {
      try {
        handler(params)
      } catch (error) {
        this.log("error", `Handler for ${event} failed: ${String(error)}`)
      }
    }
  }
}

/**
 * Timers that outlive what a hidden WebView is allowed: Blink aligns a
 * background page's timers to a second and, after five minutes hidden,
 * chained timers to a minute, which would make `alarms` and the settings
 * hand-off's long waits drift. Delays at or beyond the threshold are kept by
 * Java (`timer.set`, cancelled with `timer.clear`, fired back as
 * `timer.fired`); short ones stay in the page, where a second's alignment is
 * harmless. Returns the globals to their originals.
 */
/** Where Java-backed timer ids start: beyond any id Blink hands a page in its lifetime. */
export const NATIVE_TIMER_BASE = 0x40000000

export function installNativeTimers(channel: JavaChannel, thresholdMs = 5_000): () => void {
  const scope = globalThis as unknown as {
    setTimeout: typeof setTimeout
    clearTimeout: typeof clearTimeout
  }
  const originalSet = scope.setTimeout
  const originalClear = scope.clearTimeout
  const native = new Map<number, () => void>()
  let nextNative = 1
  // Blink numbers the page's own timers from 1 up, odd and even alike; Java's
  // start far above them, so clearing one never cancels the other.
  const nativeId = (): number => NATIVE_TIMER_BASE + nextNative++
  channel.onEvent("timer.fired", (params) => {
    const { timerId } = params as TimerFiredParams
    const callback = native.get(timerId)
    if (!callback) return
    native.delete(timerId)
    callback()
  })
  scope.setTimeout = ((callback: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
    const ms = typeof delay === "number" && Number.isFinite(delay) ? Math.max(0, delay) : 0
    if (ms < thresholdMs || typeof callback !== "function") return originalSet(callback, ms, ...args)
    const timerId = nativeId()
    native.set(timerId, () => callback(...args))
    channel.event("timer.set", { timerId, delayMs: ms })
    return timerId
  }) as typeof setTimeout
  scope.clearTimeout = ((handle?: number | string | NodeJS.Timeout) => {
    if (typeof handle === "number" && native.has(handle)) {
      native.delete(handle)
      channel.event("timer.clear", { timerId: handle })
      return
    }
    originalClear(handle as number)
  }) as typeof clearTimeout
  return () => {
    scope.setTimeout = originalSet
    scope.clearTimeout = originalClear
  }
}
