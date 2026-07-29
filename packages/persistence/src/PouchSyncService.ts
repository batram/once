export interface PouchEventChain {
  cancel?: () => void
  on(event: string, handler: (...args: unknown[]) => void): PouchEventChain
}

export interface PouchSyncDatabase {
  replicate: {
    from(
      target: string | PouchSyncDatabase,
      options?: Record<string, unknown>
    ): PouchEventChain
  }
  sync(
    target: string | PouchSyncDatabase,
    options: Record<string, unknown>
  ): PouchEventChain
  createIndex?(options: Record<string, unknown>): Promise<unknown>
  find?(options: Record<string, unknown>): Promise<{
    docs: Array<{ _id?: string }>
  }>
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

export interface PouchRemoteChange {
  id: string
  doc: Record<string, unknown>
  presentation: "foreground" | "background"
  authoritative?: boolean
}

export class PouchSyncService {
  private static readonly INITIAL_STORY_LIMIT = 50
  private static readonly SETTINGS_DOCUMENT_IDS = [
    "story_sources",
    "filter_list",
    "redirect_list",
    "theme",
    "animation"
  ]
  private syncHandler?: PouchEventChain
  private initialReplication?: PouchEventChain
  private generation = 0
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
  private remoteChangeHandlers = new Set<
    (change: PouchRemoteChange) => void
  >()
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

  onRemoteChange(handler: (change: PouchRemoteChange) => void): () => void {
    this.remoteChangeHandlers.add(handler)
    return () => this.remoteChangeHandlers.delete(handler)
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

  syncFrom(couchdbUrl: string, getLoadedStoryIds?: () => string[]): void {
    const syncOps = {
      live: true,
      retry: true,
      batch_size: 100
    }

    const generation = ++this.generation
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
    try {
      remote = this.createRemote(couchdbUrl)
    } catch (error) {
      this.updateStatus({
        state: "error",
        message: "Database synchronization could not start"
      })
      this.report("sync.configure", "Database synchronization could not start", error)
      return
    }

    void this.runInitialSync(remote, generation, getLoadedStoryIds)
      .then((initialChanges) => {
        if (this.generation !== generation) return
        this.initialReplication = undefined
        this.startLiveSync(remote, syncOps, initialChanges)
      })
      .catch((error) => {
        if (this.generation !== generation) return
        this.initialReplication = undefined
        console.error("pouch sync error", error)
        this.updateStatus({
          state: "error",
          message: "Could not connect to CouchDB; see the error log"
        })
        this.report(
          "sync.initial",
          "Initial database synchronization failed",
          error
        )
      })
  }

  private async runInitialSync(
    remote: string | PouchSyncDatabase,
    generation: number,
    getLoadedStoryIds?: () => string[]
  ): Promise<number> {
    let changes = 0
    const replicateStage = async (
      message: string | ((stageChanges: number) => string),
      options?: Record<string, unknown>,
      presentation: "foreground" | "background" = "background",
      authoritative = false
    ): Promise<void> => {
      if (this.generation !== generation) return
      let stageChanges = 0
      const currentMessage = () =>
        typeof message === "string" ? message : message(stageChanges)
      this.updateStatus({
        state: "syncing",
        message: currentMessage(),
        changes
      })
      await this.replicateOnce(
        remote,
        options,
        generation,
        presentation,
        authoritative,
        (count) => {
          stageChanges += count
          changes += count
          this.updateStatus({
            state: "syncing",
            message: currentMessage(),
            changes
          })
        }
      )
    }

    await replicateStage("Syncing settings…", {
      doc_ids: PouchSyncService.SETTINGS_DOCUMENT_IDS
    })

    const loadedStoryIds = Array.from(new Set(getLoadedStoryIds?.() ?? []))
    if (loadedStoryIds.length > 0) {
      await replicateStage(
        "Refreshing loaded stories…",
        { doc_ids: loadedStoryIds },
        "foreground",
        true
      )
    }

    const newestIds = await this.findNewestStoryIds(remote, generation)
    if (newestIds.length > 0) {
      await replicateStage(
        (stageChanges) =>
          `Loading newest stories (${Math.min(stageChanges, newestIds.length)}/${newestIds.length})…`,
        { doc_ids: newestIds },
        "foreground"
      )
    }

    await replicateStage("Loading older stories…")
    return changes
  }

  private replicateOnce(
    remote: string | PouchSyncDatabase,
    options: Record<string, unknown> | undefined,
    generation: number,
    presentation: "foreground" | "background",
    authoritative: boolean,
    onChange: (count: number) => void
  ): Promise<number> {
    return new Promise((resolve, reject) => {
      let stageChanges = 0
      const replication = this.db.replicate.from(remote, options)
      this.initialReplication = replication
      replication
        .on("change", (info: unknown) => {
          if (
            this.generation !== generation ||
            this.initialReplication !== replication
          ) {
            return
          }
          const count = this.changeCount(info)
          stageChanges += count
          onChange(count)
          this.notifyRemoteChanges(
            info,
            false,
            presentation,
            authoritative
          )
        })
        .on("complete", () => {
          if (
            this.generation !== generation ||
            this.initialReplication !== replication
          ) {
            return
          }
          resolve(stageChanges)
        })
        .on("error", reject)
    })
  }

  private async findNewestStoryIds(
    remote: string | PouchSyncDatabase,
    generation: number
  ): Promise<string[]> {
    if (typeof remote === "string" || !remote.createIndex || !remote.find) {
      return []
    }
    this.updateStatus({
      state: "syncing",
      message: "Finding newest stories…"
    })
    try {
      await remote.createIndex({
        index: { fields: ["ingested_at"] },
        ddoc: "once-sync",
        name: "stories-by-ingested-at"
      })
      if (this.generation !== generation) return []
      const result = await remote.find({
        selector: {
          _id: { $gte: "sto_", $lt: "sto_\uffff" },
          ingested_at: { $gte: 0 }
        },
        sort: [{ ingested_at: "desc" }],
        fields: ["_id"],
        limit: PouchSyncService.INITIAL_STORY_LIMIT
      })
      return result.docs
        .map((doc) => doc._id)
        .filter((id): id is string => typeof id === "string")
    } catch (error) {
      console.warn(
        "Newest-first CouchDB sync is unavailable; loading the full database",
        error
      )
      return []
    }
  }

  private startLiveSync(
    remote: string | PouchSyncDatabase,
    syncOps: Record<string, unknown>,
    initialChanges: number
  ): void {
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
        this.notifyRemoteChanges(event, true, "foreground")
        const changes = this.changeCount(event)
        this.updateStatus({
          state: "syncing",
          message: changes === 1 ? "Syncing 1 change…" : `Syncing ${changes} changes…`,
          changes
        })
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
        this.updateStatus(
          error
            ? {
              state: "retrying",
              message: "Connection interrupted; retrying…"
            }
            : { state: "up-to-date", message: "Up to date" }
        )
      })
  }

  private notifyRemoteChanges(
    event: unknown,
    requirePull = false,
    presentation: "foreground" | "background" = "background",
    authoritative = false
  ): void {
    if (!event || typeof event !== "object") return
    const record = event as {
      direction?: string
      docs?: Array<Record<string, unknown>>
      change?: { docs?: Array<Record<string, unknown>> }
    }
    if (requirePull && record.direction !== "pull") return
    const docs = record.docs ?? record.change?.docs ?? []
    docs.forEach((doc) => {
      if (typeof doc._id !== "string" || !doc._id.startsWith("sto_")) return
      const change = {
        id: doc._id,
        doc,
        presentation,
        ...(authoritative ? { authoritative: true } : {})
      }
      this.remoteChangeHandlers.forEach((handler) => handler(change))
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
