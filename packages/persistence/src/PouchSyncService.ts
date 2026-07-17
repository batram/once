export interface PouchEventChain {
  cancel?: () => void
  on(event: string, handler: (...args: unknown[]) => void): PouchEventChain
}

export interface PouchSyncDatabase {
  replicate: {
    from(target: string | PouchSyncDatabase): PouchEventChain
  }
  sync(
    target: string | PouchSyncDatabase,
    options: Record<string, unknown>
  ): PouchEventChain
}

export class PouchSyncService {
  private syncHandler?: PouchEventChain
  private initialReplication?: PouchEventChain
  private diagnosticHandlers = new Set<(error: {
    severity: "warning" | "error"
    operation: string
    message: string
    details?: string
    sourceUrl?: string
    storyUrl?: string
    documentId?: string
  }) => void>()

  constructor(
    private db: PouchSyncDatabase,
    private onChange: (event: unknown) => void,
    private createRemote: (url: string) => string | PouchSyncDatabase = (url) =>
      url
  ) {}

  onDiagnostic(handler: (error: {
    severity: "warning" | "error"
    operation: string
    message: string
    details?: string
    sourceUrl?: string
    storyUrl?: string
    documentId?: string
  }) => void): () => void {
    this.diagnosticHandlers.add(handler)
    return () => this.diagnosticHandlers.delete(handler)
  }

  private report(operation: string, message: string, error: unknown): void {
    let detail: string
    if (error instanceof Error) {
      detail = `${error.name}: ${error.message}${error.stack ? `\n${error.stack}` : ""}`
    } else {
      try {
        detail = JSON.stringify(error, null, 2) || String(error)
      } catch {
        detail = String(error)
      }
    }
    this.diagnosticHandlers.forEach((handler) =>
      handler({ severity: "error", operation, message, details: detail })
    )
  }

  syncFrom(couchdbUrl: string): void {
    const syncOps = {
      live: true,
      retry: true,
      batch_size: 100
    }

    this.initialReplication?.cancel?.()
    this.syncHandler?.cancel?.()
    this.syncHandler = undefined

    let remote: string | PouchSyncDatabase
    let initialReplication: PouchEventChain
    try {
      remote = this.createRemote(couchdbUrl)
      initialReplication = this.db.replicate.from(remote)
    } catch (error) {
      this.report("sync.configure", "Database synchronization could not start", error)
      return
    }
    this.initialReplication = initialReplication

    initialReplication
      .on("complete", (info: unknown) => {
        console.log("complete info replicate", info)
        if (this.initialReplication !== initialReplication) return
        this.initialReplication = undefined
        this.syncHandler = this.db.sync(remote, syncOps)
        this.syncHandler
          .on("change", (event: unknown) => {
            this.onChange(event)
          })
          .on("complete", (info: unknown) => {
            console.debug("pouch sync stopped", info)
          })
          .on("error", (err: unknown) => {
            console.error("pouch err", err)
            this.report("sync.live", "Database synchronization failed", err)
          })
          .on("denied", (err: unknown) => {
            console.error("pouch denied", err)
            this.report(
              "sync.denied",
              "The remote database denied a synchronized change",
              err
            )
          })
          .on("paused", () => {
            console.info("pouch paused")
          })
      })
      .on("error", (e: unknown) => {
        if (this.initialReplication === initialReplication) {
          this.initialReplication = undefined
        }
        console.error("pouch sync error", e)
        this.report("sync.initial", "Initial database synchronization failed", e)
      })
  }
}
