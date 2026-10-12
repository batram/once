import { AiError } from "@once/core"

/** Shared bounds for addons and built-in consumers. Abort detaches uncancellable native work. */
export class AiRequestRunner {
  private readonly active = new Map<string, number>()
  constructor(private readonly timeoutMs = 120_000) {}
  async run<T>(consumer: string, external: AbortSignal | undefined, work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    external?.throwIfAborted()
    if ([...this.active.values()].reduce((sum, count) => sum + count, 0) >= 6 || (this.active.get(consumer) ?? 0) >= 3) throw new AiError("AI is busy. Wait for a request to finish before trying again.", "busy")
    this.active.set(consumer, (this.active.get(consumer) ?? 0) + 1)
    const controller = new AbortController()
    const abort = () => controller.abort()
    external?.addEventListener("abort", abort, { once: true })
    const timer = setTimeout(abort, this.timeoutMs)
    const cancelled = new Promise<never>((_resolve, reject) => controller.signal.addEventListener("abort", () => reject(new AiError(external?.aborted ? "Request cancelled" : "AI request timed out", external?.aborted ? "cancelled" : "timeout")), { once: true }))
    try { return await Promise.race([work(controller.signal), cancelled]) }
    finally {
      clearTimeout(timer); external?.removeEventListener("abort", abort)
      this.active.set(consumer, Math.max(0, (this.active.get(consumer) ?? 1) - 1))
      // A native transport can finish after the race. Its callbacks must remain revoked.
      controller.abort()
    }
  }
}
