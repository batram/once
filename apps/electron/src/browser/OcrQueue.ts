/** Bound both CPU work and retained input, including callers other than the image menu. */
export class OcrQueue {
  private running = 0
  private readonly waiting: { run(): void; cancel(): void }[] = []
  constructor(private readonly concurrency = 2, private readonly capacity = 2) {}

  run<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
    signal.throwIfAborted()
    if (this.running >= this.concurrency && this.waiting.length >= this.capacity) return Promise.reject(new Error("Recognition is busy. Try again shortly."))
    return new Promise((resolve, reject) => {
      const entry = {
        cancel: () => {
          const index = this.waiting.indexOf(entry)
          if (index >= 0) this.waiting.splice(index, 1)
          signal.removeEventListener("abort", entry.cancel)
          reject(signal.reason ?? new Error("Recognition cancelled"))
        },
        run: () => {
          signal.removeEventListener("abort", entry.cancel)
          if (signal.aborted) { entry.cancel(); this.next(); return }
          this.running++
          void Promise.resolve().then(work).then(resolve, reject).finally(() => { this.running--; this.next() })
        }
      }
      if (this.running < this.concurrency) entry.run()
      else { this.waiting.push(entry); signal.addEventListener("abort", entry.cancel, { once: true }) }
    })
  }

  private next(): void {
    if (this.running < this.concurrency) this.waiting.shift()?.run()
  }
}
