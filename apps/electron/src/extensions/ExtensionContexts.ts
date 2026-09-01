import { WebContents } from "electron"
import { EXTENSION_IPC, ExtensionContextKind, ExtensionEvent, ExtensionReply } from "./protocol"
import { WebRequestListenerSpec } from "./webRequestDetails"

/** One listener the preload registered: webRequest ones carry their filter. */
export type ListenerRecord = WebRequestListenerSpec | null

export interface ContextEntry {
  readonly id: number
  readonly kind: ExtensionContextKind
  readonly contents: WebContents
  /** `api.event` → listener id → spec. */
  readonly listeners: Map<string, Map<number, ListenerRecord>>
}

interface PendingReply {
  resolve(results: unknown[]): void
  timer: NodeJS.Timeout
}

export interface EventTarget {
  entry: ContextEntry
  listenerIds: number[]
}

/**
 * The pages one extension currently has open (background, popup, options),
 * which of them listen to what, and the request/reply channel main uses when
 * an event needs an answer: a blocking webRequest decision or a message
 * response.
 */
export class ExtensionContexts {
  private readonly entries = new Map<number, ContextEntry>()
  private readonly pending = new Map<number, PendingReply>()
  private nextToken = 1

  add(contents: WebContents, kind: ExtensionContextKind): ContextEntry {
    const entry: ContextEntry = {
      id: contents.id,
      kind,
      contents,
      listeners: new Map()
    }
    this.entries.set(entry.id, entry)
    contents.once("destroyed", () => this.remove(entry.id))
    return entry
  }

  remove(id: number): void {
    this.entries.delete(id)
  }

  get(id: number): ContextEntry | undefined {
    return this.entries.get(id)
  }

  all(): ContextEntry[] {
    return [...this.entries.values()]
  }

  background(): ContextEntry | undefined {
    return this.all().find((entry) => entry.kind === "background")
  }

  addListener(
    contextId: number,
    api: string,
    event: string,
    listenerId: number,
    spec: ListenerRecord
  ): void {
    const entry = this.entries.get(contextId)
    if (!entry) return
    const key = `${api}.${event}`
    let listeners = entry.listeners.get(key)
    if (!listeners) {
      listeners = new Map()
      entry.listeners.set(key, listeners)
    }
    listeners.set(listenerId, spec)
  }

  removeListener(contextId: number, api: string, event: string, listenerId: number): void {
    this.entries.get(contextId)?.listeners.get(`${api}.${event}`)?.delete(listenerId)
  }

  /** Contexts with at least one listener for the event, and which listeners. */
  targets(
    api: string,
    event: string,
    select: (spec: ListenerRecord) => boolean = () => true,
    exclude?: number
  ): EventTarget[] {
    const key = `${api}.${event}`
    const targets: EventTarget[] = []
    for (const entry of this.entries.values()) {
      if (entry.id === exclude || entry.contents.isDestroyed()) continue
      const listeners = entry.listeners.get(key)
      if (!listeners) continue
      const listenerIds = [...listeners.entries()]
        .filter(([, spec]) => select(spec))
        .map(([id]) => id)
      if (listenerIds.length > 0) targets.push({ entry, listenerIds })
    }
    return targets
  }

  /** Fire and forget to every listening context. */
  emit(api: string, event: string, args: unknown[], exclude?: number): void {
    for (const target of this.targets(api, event, () => true, exclude)) {
      this.emitTo(target, api, event, args)
    }
  }

  /** Fire and forget to one context's selected listeners. */
  emitTo(target: EventTarget, api: string, event: string, args: unknown[]): void {
    this.send(target, { api, event, args, listeners: target.listenerIds })
  }

  /**
   * Sends the event and waits for the context's listeners to answer. Resolves
   * with one result per listener, or an empty list when the context does not
   * answer in time or goes away.
   */
  request(
    target: EventTarget,
    api: string,
    event: string,
    args: unknown[],
    timeoutMs: number
  ): Promise<unknown[]> {
    return new Promise((resolve) => {
      const token = this.nextToken++
      const timer = setTimeout(() => {
        this.pending.delete(token)
        resolve([])
      }, timeoutMs)
      this.pending.set(token, { resolve, timer })
      this.send(target, { api, event, args, token, listeners: target.listenerIds })
    })
  }

  handleReply(senderId: number, reply: ExtensionReply): void {
    if (!this.entries.has(senderId)) return
    const pending = this.pending.get(reply.token)
    if (!pending) return
    clearTimeout(pending.timer)
    this.pending.delete(reply.token)
    pending.resolve(Array.isArray(reply.result) ? reply.result : [])
  }

  dispose(): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.resolve([])
    }
    this.pending.clear()
    for (const entry of this.entries.values()) {
      if (!entry.contents.isDestroyed()) entry.contents.close()
    }
    this.entries.clear()
  }

  private send(target: EventTarget, message: ExtensionEvent & { listeners: number[] }): void {
    if (target.entry.contents.isDestroyed()) return
    target.entry.contents.send(EXTENSION_IPC.event, message)
  }
}
