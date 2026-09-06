import {
  HostToSandbox,
  SANDBOX_LIMITS,
  SANDBOX_PROTOCOL,
  SANDBOX_TIMEOUTS,
  SandboxOperation,
  SandboxToHost,
  StoryView,
  AddonTrayEvent,
  readBadgeTexts,
  readSandboxMessage
} from "@once/core"

/** What a session needs from whoever owns the frame; DOM-free, so tests drive it. */
export interface SandboxTransport {
  post(message: HostToSandbox): void
  /** Tears the frame down; the session asks for it after a crash. */
  destroy(): void
  failed?(reason: string): void
}

export interface SandboxHostOperations {
  /** Runs one operation the script asked for; throws to refuse it. The value answers ops that asked. */
  perform(op: SandboxOperation, signal?: AbortSignal): unknown | Promise<unknown>
  report(message: string): void
}

/** Operations governed by grants rather than by the story in hand. */
const UNSCOPED_OPERATIONS = new Set(["fetch", "storage.get", "storage.set"])

interface Pending {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
  /** Story hrefs an operation raised during this request may name. */
  scope: Set<string>
  controller: AbortController
}

/**
 * One add-on's conversation with its sandbox: loads the code, sends requests
 * with timeouts, and vets what comes back. Operations are accepted only while
 * the request that raised them is open and only for the stories it was about,
 * which is what keeps an add-on acting on the story the user meant.
 */
export class AddonSandboxSession {
  private readonly pending = new Map<number, Pending>()
  private readonly connectionOperations = new Set<AbortController>()
  private nextRequest = 1
  private ready: Promise<void> | null = null
  private readyResolve: (() => void) | null = null
  private readyReject: ((error: Error) => void) | null = null
  private failures = 0
  private closed = false
  private loadTimer: ReturnType<typeof setTimeout> | null = null
  /** Stories whose badges this add-on computed; `updateBadge` may name them. */
  private readonly badgeScope = new Map<string, Set<string>>()

  constructor(
    readonly addonId: string,
    private readonly transport: SandboxTransport,
    private readonly host: SandboxHostOperations
  ) {}

  get disabled(): boolean {
    return this.failures >= SANDBOX_LIMITS.failures
  }

  /** Sends the code once the frame is up; resolves when the script reported ready. */
  load(code: string, settings: Readonly<Record<string, unknown>>): Promise<void> {
    if (this.ready) return this.ready
    this.closed = false
    this.ready = new Promise<void>((resolve, reject) => {
      this.readyResolve = resolve
      this.readyReject = reject
      this.loadTimer = setTimeout(() => this.fail("did not start in time"), SANDBOX_TIMEOUTS.loadMs)
      this.readyResolve = () => {
        if (this.loadTimer) clearTimeout(this.loadTimer)
        this.loadTimer = null
        this.readyReject = null
        resolve()
      }
    })
    this.transport.post({ type: "load", protocol: SANDBOX_PROTOCOL, addonId: this.addonId, code, settings })
    return this.ready
  }

  settings(settings: Readonly<Record<string, unknown>>): void {
    this.cancelAll()
    this.transport.post({ type: "settings", settings })
  }

  cancelAll(): void {
    for (const controller of this.connectionOperations) controller.abort()
    for (const id of this.pending.keys()) this.cancel(id)
  }

  private cancel(id: number): void {
    this.pending.get(id)?.controller.abort()
    this.transport.post({ type: "cancel", requestId: id })
    this.settle(id, entry => entry.reject(new Error("Request cancelled")))
  }

  tray(tray: string, event: AddonTrayEvent, story: StoryView, signal: AbortSignal): Promise<unknown> {
    if (signal.aborted) return Promise.reject(new Error("Request cancelled"))
    if (Array.from(this.pending.values()).filter(entry => entry.scope.size).length >= 2) {
      return Promise.reject(new Error("Two addon requests are already running; try again when one finishes"))
    }
    const id = this.nextRequest
    const cancel = () => this.cancel(id)
    signal.addEventListener("abort", cancel, { once: true })
    return this.request(requestId => ({ type: "tray", requestId, tray, event, story }), new Set([story.href]), SANDBOX_TIMEOUTS.trayMs)
      .finally(() => signal.removeEventListener("abort", cancel))
  }

  invoke(action: string, story: StoryView): Promise<unknown> {
    return this.request(
      (requestId) => ({ type: "invoke", requestId, action, story }),
      new Set([story.href]),
      SANDBOX_TIMEOUTS.invokeMs
    )
  }

  async badges(contribution: string, stories: readonly StoryView[]): Promise<string[]> {
    const scope = this.badgeScope.get(contribution) ?? new Set<string>()
    for (const story of stories) scope.add(story.href)
    this.badgeScope.set(contribution, scope)
    const value = await this.request(
      (requestId) => ({ type: "badges", requestId, contribution, stories }),
      new Set(stories.map((story) => story.href)),
      SANDBOX_TIMEOUTS.badgesMs
    )
    return readBadgeTexts(value, stories.length)
  }

  /** A toolbar button: no story in hand, so story operations are refused during it. */
  panelInvoke(action: string): Promise<unknown> {
    return this.request(
      (requestId) => ({ type: "panel.invoke", requestId, action }),
      new Set(),
      SANDBOX_TIMEOUTS.invokeMs
    )
  }

  /** A collector's parse: the body goes in, plain story objects come back. */
  collectorParse(collector: string, url: string, body: string | Record<string, unknown>, config: unknown): Promise<unknown> {
    return this.request(
      (requestId) => ({ type: "collector.parse", requestId, collector, url, body, config }),
      new Set(),
      SANDBOX_TIMEOUTS.parseMs
    )
  }

  collectorSearch(collector: string, kind: "global" | "domain", needle: string): Promise<unknown> {
    return this.request(
      (requestId) => ({ type: "collector.search", requestId, collector, kind, needle }),
      new Set(),
      SANDBOX_TIMEOUTS.searchMs
    )
  }

  /** Every message from the frame lands here, already known to be from it. */
  receive(data: unknown): void {
    if (this.closed) return
    const message = readSandboxMessage(data)
    if (!message) return
    switch (message.type) {
      case "ready":
        if (message.protocol !== SANDBOX_PROTOCOL) {
          this.fail(`speaks protocol ${message.protocol}, not ${SANDBOX_PROTOCOL}`)
          return
        }
        this.readyResolve?.()
        break
      case "result":
        this.settle(message.requestId, (entry) => entry.resolve(message.value))
        break
      case "error":
        if (message.requestId === undefined) {
          this.fail(message.message)
        } else {
          this.settle(message.requestId, (entry) => entry.reject(new Error(message.message)))
        }
        break
      case "op":
        this.operation(message)
        break
    }
  }

  dispose(): void {
    if (this.closed) return
    this.closed = true
    for (const controller of this.connectionOperations) controller.abort()
    if (this.loadTimer) clearTimeout(this.loadTimer)
    this.loadTimer = null
    this.readyReject?.(new Error("Add-on sandbox closed"))
    this.readyReject = null
    this.readyResolve = null
    this.ready = null
    this.badgeScope.clear()
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.controller.abort()
      entry.reject(new Error("Add-on sandbox closed"))
      this.pending.delete(id)
    }
    this.transport.destroy()
  }

  private request(
    build: (requestId: number) => HostToSandbox,
    scope: Set<string>,
    timeoutMs: number
  ): Promise<unknown> {
    if (this.disabled) return Promise.reject(new Error(`Add-on ${this.addonId} is switched off after repeated failures`))
    if (this.closed) return Promise.reject(new Error("Add-on sandbox closed"))
    const requestId = this.nextRequest++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.get(requestId)?.controller.abort()
        this.transport.post({ type: "cancel", requestId })
        this.settle(requestId, (entry) => entry.reject(new Error("Add-on did not answer in time")))
      }, timeoutMs)
      this.pending.set(requestId, { resolve, reject, timer, scope, controller: new AbortController() })
      this.transport.post(build(requestId))
    })
  }

  private settle(requestId: number, finish: (entry: Pending) => void): void {
    const entry = this.pending.get(requestId)
    if (!entry) return
    clearTimeout(entry.timer)
    this.pending.delete(requestId)
    finish(entry)
  }

  private operation(message: Extract<SandboxToHost, { type: "op" }>): void {
    const { op, opId } = message
    const pending = message.requestId !== undefined ? this.pending.get(message.requestId) : undefined
    const inScope = UNSCOPED_OPERATIONS.has(op.name) || (op.name === "request" && (message.requestId === undefined || !!pending)) ||
      (op.name === "updateBadge"
        ? this.badgeScope.get(op.contribution)?.has(op.href) === true
        : message.requestId !== undefined && this.pending.get(message.requestId)?.scope.has(op.href) === true)
    if (!inScope) {
      this.host.report(`Add-on ${this.addonId} tried ${op.name} on a story it was not asked about`)
      if (opId !== undefined) this.transport.post({ type: "opResult", opId, ok: false, error: "not allowed for this story" })
      return
    }
    void Promise.resolve()
      .then(() => {
        if (this.closed) throw new Error("Add-on sandbox closed")
        if (op.name === "request" || op.name === "story.content") {
          pending?.controller.signal.throwIfAborted()
          if (message.requestId !== undefined && !this.pending.has(message.requestId)) throw new Error("Request is no longer active")
        }
        if (op.name === "request") return this.connectionOperation(op, pending?.controller.signal)
        return this.host.perform(op, pending?.controller.signal)
      })
      .then((value) => {
        if (!this.closed && opId !== undefined) this.transport.post({ type: "opResult", opId, ok: true, value })
      })
      .catch((error) => {
        const text = error instanceof Error ? error.message : String(error)
        if (op.name !== "request" && op.name !== "story.content") this.host.report(`Add-on ${this.addonId} ${op.name} failed: ${text}`)
        if (!this.closed && opId !== undefined) this.transport.post({ type: "opResult", opId, ok: false, error: text })
      })
  }

  private async connectionOperation(op: SandboxOperation, signal?: AbortSignal): Promise<unknown> {
    if (this.connectionOperations.size >= 2) throw new Error("Two connection requests are already running")
    const controller = new AbortController()
    const abort = () => controller.abort()
    signal?.throwIfAborted()
    signal?.addEventListener("abort", abort, { once: true })
    this.connectionOperations.add(controller)
    let timer: ReturnType<typeof setTimeout> | undefined
    const cancelled = new Promise<never>((_resolve, reject) => {
      controller.signal.addEventListener("abort", () => reject(new Error("Request cancelled or timed out")), { once: true })
      timer = setTimeout(abort, SANDBOX_TIMEOUTS.trayMs)
    })
    try { return await Promise.race([this.host.perform(op, controller.signal), cancelled]) }
    finally {
      clearTimeout(timer)
      signal?.removeEventListener("abort", abort)
      this.connectionOperations.delete(controller)
    }
  }

  /** A crash or a broken start: count it, close the frame, fail what waits. */
  private fail(reason: string): void {
    if (this.closed) return
    this.failures += 1
    this.host.report(`Add-on ${this.addonId} ${reason}`)
    this.readyReject?.(new Error(reason))
    this.readyResolve = null
    this.readyReject = null
    this.ready = null
    this.dispose()
    this.transport.failed?.(reason)
  }
}
