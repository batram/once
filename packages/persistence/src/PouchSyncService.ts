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

export interface PouchSyncStatus {
  state:
    | "disabled"
    | "connecting"
    | "syncing"
    | "up-to-date"
    | "retrying"
    | "error"
  message: string
  changes?: number
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
  private statusHandlers = new Set<(status: PouchSyncStatus) => void>()
  private status: PouchSyncStatus = {
    state: "disabled",
    message: "Sync is not configured"
  }

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

  onStatus(handler: (status: PouchSyncStatus) => void): () => void {
    this.statusHandlers.add(handler)
    handler(this.status)
    return () => this.statusHandlers.delete(handler)
  }

  private updateStatus(status: PouchSyncStatus): void {
    this.status = status
    this.statusHandlers.forEach((handler) => handler(status))
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
    this.initialReplication = undefined
    this.syncHandler = undefined

    if (!couchdbUrl.trim()) {
      this.updateStatus({
        state: "disabled",
        message: "Sync is not configured"
      })
      return
    }

    this.updateStatus({
      state: "connecting",
      message: "Connecting and checking for remote changes…"
    })

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
    let initialChanges = 0

    initialReplication
      .on("change", (info: unknown) => {
        if (this.initialReplication !== initialReplication) return
        const docs = this.changeCount(info)
        initialChanges += docs
        this.updateStatus({
          state: "syncing",
          message: `Downloading remote changes (${initialChanges})…`,
          changes: initialChanges
        })
      })
      .on("complete", (info: unknown) => {
        console.log("complete info replicate", info)
        if (this.initialReplication !== initialReplication) return
        this.initialReplication = undefined
        this.updateStatus({
          state: "up-to-date",
          message: initialChanges
            ? `Up to date · ${initialChanges} remote changes received`
            : "Up to date",
          changes: initialChanges
        })
        this.syncHandler = this.db.sync(remote, syncOps)
        this.syncHandler
          .on("change", (event: unknown) => {
            this.onChange(event)
            const changes = this.changeCount(event)
            this.updateStatus({
              state: "syncing",
              message: changes === 1 ? "Syncing 1 change…" : `Syncing ${changes} changes…`,
              changes
            })
          })
          .on("complete", (info: unknown) => {
            console.debug("pouch sync stopped", info)
          })
          .on("error", (err: unknown) => {
            console.error("pouch err", err)
            this.updateStatus({
              state: "error",
              message: "Sync failed; see the error log"
            })
            this.report("sync.live", "Database synchronization failed", err)
          })
          .on("denied", (err: unknown) => {
            console.error("pouch denied", err)
            this.updateStatus({
              state: "error",
              message: "A remote change was denied; see the error log"
            })
            this.report(
              "sync.denied",
              "The remote database denied a synchronized change",
              err
            )
          })
          .on("active", () => {
            this.updateStatus({ state: "syncing", message: "Syncing changes…" })
          })
          .on("paused", (error: unknown) => {
            console.info("pouch paused")
            this.updateStatus(
              error
                ? {
                  state: "retrying",
                  message: "Connection interrupted; retrying…"
                }
                : { state: "up-to-date", message: "Up to date" }
            )
          })
      })
      .on("error", (e: unknown) => {
        if (this.initialReplication === initialReplication) {
          this.initialReplication = undefined
        }
        console.error("pouch sync error", e)
        this.updateStatus({
          state: "error",
          message: "Could not connect to CouchDB; see the error log"
        })
        this.report("sync.initial", "Initial database synchronization failed", e)
      })
  }

  private changeCount(info: unknown): number {
    if (!info || typeof info !== "object") return 1
    const record = info as {
      docs?: unknown[]
      change?: { docs?: unknown[]; docs_written?: number }
      docs_written?: number
    }
    return (
      record.docs?.length ??
      record.change?.docs?.length ??
      record.docs_written ??
      record.change?.docs_written ??
      1
    )
  }
}
