import { AiError } from "@once/core"

/** Shared bounds for addons and built-in consumers. Requests over a bound wait their turn; abort detaches uncancellable native work. */
export class AiRequestRunner {
  private readonly active = new Map<string, number>()
  private total = 0
  private readonly waiting: { consumer: string; start: () => void }[] = []
  constructor(private readonly timeoutMs = 120_000, private readonly perConsumer = 12, private readonly overall = 24) {}
  async run<T>(consumer: string, external: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    external?.throwIfAborted()
    await this.acquire(consumer, external)
    const controller = new AbortController()
    const abort = () => controller.abort()
    // The timeout counts from the start of the work, not from the time spent waiting for a slot.
    const timer = setTimeout(abort, this.timeoutMs)
    try {
      if (external?.aborted) throw new AiError("Request cancelled", "cancelled")
      external?.addEventListener("abort", abort, { once: true })
      const cancelled = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new AiError(external?.aborted ? "Request cancelled" : "AI request timed out", external?.aborted ? "cancelled" : "timeout")), { once: true }))
      return await Promise.race([work(controller.signal), cancelled])
    } finally {
      clearTimeout(timer); external?.removeEventListener("abort", abort)
      // A native transport can finish after the race. Its callbacks must remain revoked.
      controller.abort()
      this.release(consumer)
    }
  }
  private acquire(consumer: string, external: AbortSignal | undefined): Promise<void> {
    return new Promise((resolve, reject) => {
      const entry = { consumer, start: () => { external?.removeEventListener("abort", leave); resolve() } }
      const leave = () => { this.waiting.splice(this.waiting.indexOf(entry), 1); reject(new AiError("Request cancelled", "cancelled")) }
      external?.addEventListener("abort", leave, { once: true })
      this.waiting.push(entry)
      this.drain()
    })
  }
  private release(consumer: string) {
    this.total--
    this.active.set(consumer, Math.max(0, (this.active.get(consumer) ?? 1) - 1))
    this.drain()
  }
  /** Starts waiters in arrival order; one consumer at its own bound does not hold back the others. */
  private drain() {
    for (const entry of [...this.waiting]) {
      if (this.total >= this.overall) return
      if ((this.active.get(entry.consumer) ?? 0) >= this.perConsumer) continue
      this.waiting.splice(this.waiting.indexOf(entry), 1)
      this.total++
      this.active.set(entry.consumer, (this.active.get(entry.consumer) ?? 0) + 1)
      entry.start()
    }
  }
}
