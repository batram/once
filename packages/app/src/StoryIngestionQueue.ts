/** Shared by source batches; per-URL writes enter this gate after their predecessors. */
export class StoryIngestionQueue {
  private active = 0
  private readonly waiting = new Set<() => void>()

  constructor(private readonly concurrency = 64) {
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new Error("Story ingestion concurrency must be a positive integer")
    }
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.concurrency) {
      await new Promise<void>((resolve) => this.waiting.add(resolve))
    } else {
      this.active++
    }
    try {
      return await task()
    } finally {
      const next = this.waiting.values().next().value
      if (next) {
        // Transfer the slot directly so new arrivals cannot overtake waiters.
        this.waiting.delete(next)
        next()
      } else {
        this.active--
      }
    }
  }
}
