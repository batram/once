import { WebContents, WebFrameMain } from "electron"
import { EXTENSION_IPC, ExtensionContextKind, ExtensionEvent, ExtensionReply } from "./protocol"
import { WebRequestListenerSpec } from "./webRequestDetails"

/** One listener the preload registered: webRequest ones carry their filter. */
export type ListenerRecord = WebRequestListenerSpec | null

export interface ContextEntry {
  readonly id: string
  readonly kind: ExtensionContextKind
  /** The tab a content-script context lives in; -1 for extension pages. */
  readonly tabId: number
  readonly frameId: number
  /** `api.event` → listener id → spec. */
  readonly listeners: Map<string, Map<number, ListenerRecord>>
  url(): string
  isDestroyed(): boolean
  send(message: ExtensionEvent): void
}

interface PendingReply {
  resolve(results: unknown[]): void
  timer: NodeJS.Timeout
}

export interface EventTarget {
  entry: ContextEntry
  listenerIds: number[]
}

export function pageContextId(contents: WebContents): string {
  return String(contents.id)
}

// The frame-tree node id survives navigations of the same frame, so a new
// document replaces the previous document's context instead of joining it.
export function frameContextId(contents: WebContents, frame: WebFrameMain): string {
  return `${contents.id}:${frame.frameTreeNodeId}`
}

/**
 * The places one extension currently runs (background, popup, options, and
 * one entry per frame that hosts its content scripts), which of them listen
 * to what, and the request/reply channel main uses when an event needs an
 * answer: a blocking webRequest decision or a message response.
 */
export class ExtensionContexts {
  private readonly entries = new Map<string, ContextEntry>()
  private readonly pending = new Map<number, PendingReply>()
  private readonly removed = new Set<(entry: ContextEntry) => void>()
  private readonly listenerWaiters = new Set<() => void>()
  private nextToken = 1

  /** An extension page in its own webContents. */
  add(contents: WebContents, kind: ExtensionContextKind): ContextEntry {
    const entry = this.insert({
      id: pageContextId(contents),
      kind,
      tabId: -1,
      frameId: 0,
      listeners: new Map(),
      url: () => (contents.isDestroyed() ? "" : contents.getURL()),
      isDestroyed: () => contents.isDestroyed(),
      send: (message) => {
        if (!contents.isDestroyed()) contents.send(EXTENSION_IPC.event, message)
      }
    })
    contents.once("destroyed", () => this.remove(entry.id))
    return entry
  }

  /** A context with its own transport; replaces any entry with the same id. */
  addEntry(entry: ContextEntry): ContextEntry {
    return this.insert(entry)
  }

  /** This extension's content-script world inside one frame of a tab. */
  addFrame(
    contents: WebContents,
    frame: WebFrameMain,
    host: string,
    tabId: number,
    frameId: number
  ): ContextEntry {
    const id = frameContextId(contents, frame)
    const alive = () => !contents.isDestroyed() && !frame.detached
    return this.insert({
      id,
      kind: "content",
      tabId,
      frameId,
      listeners: new Map(),
      url: () => (alive() ? frame.url : ""),
      isDestroyed: () => !alive(),
      send: (message) => {
        if (alive()) frame.send(EXTENSION_IPC.event, { ...message, host })
      }
    })
  }

  private insert(entry: ContextEntry): ContextEntry {
    const existing = this.entries.get(entry.id)
    if (existing) this.remove(existing.id)
    this.entries.set(entry.id, entry)
    return entry
  }

  remove(id: string): void {
    const entry = this.entries.get(id)
    if (!entry) return
    this.entries.delete(id)
    for (const listener of this.removed) listener(entry)
  }

  /** Runs when a context goes away, so ports and pending work can close. */
  onRemoved(listener: (entry: ContextEntry) => void): void {
    this.removed.add(listener)
  }

  get(id: string | number): ContextEntry | undefined {
    return this.entries.get(String(id))
  }

  all(): ContextEntry[] {
    return [...this.entries.values()]
  }

  addListener(
    contextId: string | number,
    api: string,
    event: string,
    listenerId: number,
    spec: ListenerRecord
  ): void {
    const entry = this.entries.get(String(contextId))
    if (!entry) return
    const key = `${api}.${event}`
    let listeners = entry.listeners.get(key)
    if (!listeners) {
      listeners = new Map()
      entry.listeners.set(key, listeners)
    }
    listeners.set(listenerId, spec)
    for (const waiter of this.listenerWaiters) waiter()
  }

  /**
   * Resolves once some context listens to the event, which for a background
   * page can be well after its document loaded: extensions register their
   * handlers at the end of an asynchronous start-up.
   */
  whenListening(api: string, event: string, timeoutMs: number): Promise<void> {
    if (this.targets(api, event).length > 0) return Promise.resolve()
    return new Promise((resolve, reject) => {
      const check = () => {
        if (this.targets(api, event).length === 0) return
        cleanup()
        resolve()
      }
      const timer = setTimeout(() => {
        cleanup()
        reject(new Error(`No page listens to ${api}.${event}`))
      }, timeoutMs)
      const cleanup = () => {
        clearTimeout(timer)
        this.listenerWaiters.delete(check)
      }
      this.listenerWaiters.add(check)
    })
  }

  removeListener(contextId: string | number, api: string, event: string, listenerId: number): void {
    this.entries.get(String(contextId))?.listeners.get(`${api}.${event}`)?.delete(listenerId)
  }

  /** Contexts with at least one listener for the event, and which listeners. */
  targets(
    api: string,
    event: string,
    select: (spec: ListenerRecord, entry: ContextEntry) => boolean = () => true,
    exclude?: string | number
  ): EventTarget[] {
    const key = `${api}.${event}`
    const excluded = exclude === undefined ? undefined : String(exclude)
    const targets: EventTarget[] = []
    for (const entry of this.entries.values()) {
      if (entry.id === excluded || entry.isDestroyed()) continue
      const listeners = entry.listeners.get(key)
      if (!listeners) continue
      const listenerIds = [...listeners.entries()]
        .filter(([, spec]) => select(spec, entry))
        .map(([id]) => id)
      if (listenerIds.length > 0) targets.push({ entry, listenerIds })
    }
    return targets
  }

  /** Fire and forget to every listening context. */
  emit(api: string, event: string, args: unknown[], exclude?: string | number): void {
    for (const target of this.targets(api, event, () => true, exclude)) {
      this.emitTo(target, api, event, args)
    }
  }

  /** Fire and forget to one context's selected listeners. */
  emitTo(target: EventTarget, api: string, event: string, args: unknown[]): void {
    target.entry.send({ api, event, args, listeners: target.listenerIds })
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
      target.entry.send({ api, event, args, token, listeners: target.listenerIds })
    })
  }

  handleReply(senderId: string | number, reply: ExtensionReply): void {
    if (!this.entries.has(String(senderId))) return
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
    for (const id of [...this.entries.keys()]) this.remove(id)
  }
}
