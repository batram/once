import { DiagnosticError } from "./types"

export class StoryWriteQueue {
  private readonly writes = new Map<string, Promise<unknown>>()

  constructor(
    private readonly reportFailure: (
      href: string,
      failure: Pick<DiagnosticError, "operation" | "message">,
      error: unknown
    ) => void
  ) {}

  enqueue<T>(
    href: string,
    task: () => Promise<T>,
    failure: Pick<DiagnosticError, "operation" | "message"> = {
      operation: "story.save",
      message: "A story change could not be saved"
    }
  ): Promise<T> {
    const previousWrite = this.writes.get(href)
    const waitForPrevious = previousWrite
      ? previousWrite.then(
        () => undefined,
        () => undefined
      )
      : Promise.resolve()
    const write = waitForPrevious.then(task)
    this.writes.set(href, write)
    const settle = () => {
      if (this.writes.get(href) === write) this.writes.delete(href)
    }
    write.then(settle, (error) => {
      settle()
      this.reportFailure(href, failure, error)
    })
    return write
  }

  async settled(): Promise<void> {
    while (this.writes.size > 0) {
      await Promise.allSettled(Array.from(this.writes.values()))
    }
  }
}
