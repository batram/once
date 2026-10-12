import { PouchSyncCompatibility, SyncCompatibilityError } from "./PouchSyncCompatibility"
import { listenLiveSync, watchSyncCompatibility } from "./PouchSyncWatch"
import { SYNC_COMPAT_ID, SYNC_PROTOCOL, SyncCompatibilityDetails, isRoutedTabDocId, isTabSyncChangeId, normalizeSyncUrl, ROUTED_TAB_DOC_PREFIXES, TAB_SYNC_SETTINGS_ID } from "@once/core"
import {
  PouchMaintenanceDatabase,
  PouchMaintenanceService
} from "./PouchMaintenanceService"

export interface PouchEventChain {
  cancel?: () => void
  on(event: string, handler: (...args: unknown[]) => void): PouchEventChain
}

export interface PouchSyncDatabase extends PouchMaintenanceDatabase {
  info?(): Promise<{ doc_count?: number; doc_del_count?: number; sizes?: { file?: number; active?: number }; compact_running?: boolean }>
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
  allDocs?(options: Record<string, unknown>): Promise<{ rows: Array<{ id: string }> }>
  createIndex?(options: Record<string, unknown>): Promise<unknown>
  find?(options: Record<string, unknown>): Promise<{
    docs: Array<{ _id?: string }>
  }>
}

export interface PouchSyncStatus {
  state:
    | "update-required"
    | "disabled"
    | "connecting"
    | "syncing"
    | "up-to-date"
    | "retrying"
    | "error"
  message: string
  changes?: number
  compatibility?: SyncCompatibilityDetails
}

export interface PouchRemoteChange {
  id: string
  doc: Record<string, unknown>
  presentation: "foreground" | "background"
}

export class PouchSyncService {
  private static readonly INITIAL_STORY_LIMIT = 50
  // Story documents are small. Larger bounded batches avoid turning a stale
  // checkpoint into hundreds of serial CouchDB round trips on higher-latency
  // connections. Each direction keeps its checkpoint on the receiving side:
  // pull locally, push remotely.
  private static readonly REPLICATION_OPTIONS = {
    batch_size: 1000,
    batches_limit: 2,
    checkpoint: "target"
  }
  private static readonly SETTINGS_DOCUMENT_IDS = [
    "addon_vault",
    "ai_vault",
    "addons",
    "browser_extension_sync",
    "sources",
    "cache_timing",
    "filter_list",
    "redirect_list",
    "theme",
    "animation",
    "swipe",
    "save_bookmarked_content",
    TAB_SYNC_SETTINGS_ID
  ]
  private readonly compatibility: PouchSyncCompatibility
  private stopWatch?: () => void
  private retryTimer?: ReturnType<typeof setTimeout>
  private destination = ""
  private loadedStoryIds?: () => string[]
  private syncHandler?: PouchEventChain
  private initialReplication?: PouchEventChain
  private remoteDatabase?: PouchSyncDatabase
  private generation = 0
  private settingsReplicatedGeneration = 0
  private settingsReplicatedHandlers = new Set<() => void>()
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
  private remoteTabChangeHandlers = new Set<
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
      url,
    supportedProtocol = SYNC_PROTOCOL
  ) { this.compatibility = new PouchSyncCompatibility(db, supportedProtocol) }

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

  /** Pulled tab sync records and screenshots, deletions included. */
  onRemoteTabChange(handler: (change: PouchRemoteChange) => void): () => void {
    this.remoteTabChangeHandlers.add(handler)
    return () => this.remoteTabChangeHandlers.delete(handler)
  }

  async hasLocalData(): Promise<boolean> {
    if (!this.db.allDocs) return false
    // Design documents (the local story index) say nothing about synced data.
    const result = await this.db.allDocs({ startkey: "_design\uffff", limit: 1 })
    return result.rows.length > 0
  }

  onSettingsReplicated(handler: () => void): () => void {
    this.settingsReplicatedHandlers.add(handler)
    if (this.settingsReplicatedGeneration === this.generation && this.generation > 0) {
      queueMicrotask(handler)
    }
    return () => this.settingsReplicatedHandlers.delete(handler)
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

  /** Inspect only the currently authorized transport; never create a new destination. */
  async storageInfo() {
    const generation = this.generation
    const info = await this.remoteDatabase?.info?.()
    return generation === this.generation ? info ?? null : null
  }

  syncFrom(couchdbUrl: string, getLoadedStoryIds?: () => string[]): void {
    const syncOps = {
      ...PouchSyncService.REPLICATION_OPTIONS,
      live: true,
      retry: false,
      filter: (doc: { _id?: string }) => doc._id !== SYNC_COMPAT_ID
    }

    const generation = ++this.generation
    clearTimeout(this.retryTimer); this.stopWatch?.(); this.stopWatch = undefined
    this.destination = couchdbUrl; this.loadedStoryIds = getLoadedStoryIds
    this.remoteDatabase = undefined
    this.settingsReplicatedGeneration = 0
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

    try {
      couchdbUrl = normalizeSyncUrl(couchdbUrl)
    } catch (error) {
      this.updateStatus({
        state: "error",
        message: "CouchDB URL must start with http:// or https://"
      })
      this.report("sync.configure", "The CouchDB URL is invalid", error)
      return
    }

    this.updateStatus({
      state: "connecting",
      message: "Connecting and checking for remote changes…"
    })

    let remote: string | PouchSyncDatabase
    try {
      remote = this.createRemote(couchdbUrl)
      this.remoteDatabase = typeof remote === "string" ? undefined : remote
    } catch (error) {
      this.updateStatus({
        state: "error",
        message: "Database synchronization could not start"
      })
      this.report("sync.configure", "Database synchronization could not start", error)
      return
    }

    void this.preflight(remote, couchdbUrl, generation)
      .then(() => this.generation === generation ? this.runInitialSync(remote, generation, getLoadedStoryIds) : 0)
      .then(async (initialChanges) => {
        if (this.generation !== generation) return
        this.initialReplication = undefined
        // Pulling into a database with local stories can create conflicting
        // leaves. Consolidate them before allowing any local leaf to be pushed
        // back and accidentally become the remote winner.
        const maintenanceSucceeded = await new PouchMaintenanceService(
          this.db,
          (status) => { if (this.generation === generation) this.updateStatus(status) },
          (error) => this.report(
            "database.maintenance",
            "Local database maintenance failed",
            error
          ),
          () => this.generation === generation
        ).run()
        if (this.generation !== generation || !maintenanceSucceeded) return
        await this.compatibility.check(remote as PouchSyncDatabase, couchdbUrl, 1, () => this.generation === generation)
        if (this.generation === generation) this.startLiveSync(remote, syncOps, initialChanges)
      })
      .catch((error) => {
        if (this.generation !== generation) return
        this.pauseCompatibility(error, generation)
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
      presentation: "foreground" | "background" = "background"
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
        { ...PouchSyncService.REPLICATION_OPTIONS, filter: (doc: { _id?: string }) => doc._id !== SYNC_COMPAT_ID, ...options },
        generation,
        presentation,
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
    if (this.generation !== generation) return changes
    this.settingsReplicatedGeneration = generation
    this.settingsReplicatedHandlers.forEach((handler) => handler())

    // Other devices' tabs show soon after connecting, before the stories.
    const tabDocIds = await this.findTabDocIds(remote, generation)
    if (tabDocIds.length > 0) {
      await replicateStage("Syncing tabs from other devices…", { doc_ids: tabDocIds })
    }

    const loadedStoryIds = Array.from(new Set(getLoadedStoryIds?.() ?? []))
    if (loadedStoryIds.length > 0) {
      await replicateStage(
        "Refreshing loaded stories…",
        { doc_ids: loadedStoryIds },
        "foreground"
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

    await replicateStage((stageChanges) =>
      stageChanges > 0
        ? `Loading older stories (${stageChanges} received)…`
        : "Loading older stories…"
    )
    return changes
  }

  private replicateOnce(
    remote: string | PouchSyncDatabase,
    options: Record<string, unknown> | undefined,
    generation: number,
    presentation: "foreground" | "background",
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
            presentation
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

  /** The ids of routed tab documents on the remote, by id range; none when it cannot list them. */
  private async findTabDocIds(
    remote: string | PouchSyncDatabase,
    generation: number
  ): Promise<string[]> {
    if (typeof remote === "string" || !remote.allDocs) return []
    const listDocs = remote.allDocs.bind(remote)
    try {
      const ids: string[] = []
      for (const prefix of ROUTED_TAB_DOC_PREFIXES) {
        const result = await listDocs({ startkey: prefix, endkey: `${prefix}\uffff` })
        if (this.generation !== generation) return []
        ids.push(...result.rows.map((row) => row.id).filter(isRoutedTabDocId))
      }
      return ids
    } catch (error) {
      console.warn("Tab documents will arrive with the full database", error)
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
    const generation = this.generation
    listenLiveSync(this.syncHandler, () => this.generation === generation, event => {
      this.onChange(event); this.notifyRemoteChanges(event, true, "foreground")
      this.updateStatus({ state: "syncing", message: "Syncing changes…", changes: this.changeCount(event) })
    }, busy => this.updateStatus({ state: busy ? "syncing" : "up-to-date", message: busy ? "Syncing changes…" : "Up to date" }),
    error => this.pauseCompatibility(error, generation))
  }

  private async preflight(remote: string | PouchSyncDatabase, destination: string, generation: number): Promise<void> {
    if (typeof remote === "string") throw new Error("Sync compatibility checks require a database transport")
    await this.compatibility.check(remote, destination, 1, () => this.generation === generation)
    if (this.generation !== generation) return
    this.stopWatch = watchSyncCompatibility(remote,
      () => this.compatibility.check(remote, destination, 1, () => this.generation === generation),
      error => this.pauseCompatibility(error, generation))
  }

  private pauseCompatibility(error: unknown, generation: number): void {
    if (this.generation !== generation) return
    ++this.generation
    this.initialReplication?.cancel?.(); this.syncHandler?.cancel?.(); this.stopWatch?.()
    this.settingsReplicatedGeneration = 0
    const details = error instanceof SyncCompatibilityError ? error.compatibility : undefined
    const message = error instanceof Error && /^(Sync compatibility|Sync paused)/.test(error.message) ? error.message : "Sync paused. Could not verify compatibility with the database. Check your connection and try again."
    this.report("sync.compatibility", message, new Error(message))
    this.updateStatus({ state: details ? "update-required" : "error", message, ...(details ? { compatibility: details } : {}) })
    if (!details && !message.startsWith("Sync compatibility")) this.retryTimer = setTimeout(() => this.recheckCompatibility(), 3000)
  }

  recheckCompatibility(): void { this.syncFrom(this.destination, this.loadedStoryIds) }

  async requireSyncProtocol(version: number): Promise<void> {
    if (!Number.isSafeInteger(version) || version < 1) throw new Error("Invalid sync protocol")
    const generation = this.generation
    try {
      await this.compatibility.localRequirement(version)
      if (!this.destination.trim()) return
      if (!this.remoteDatabase) throw new Error("Connect sync before changing shared formats")
      await this.compatibility.check(this.remoteDatabase, this.destination, version, () => this.generation === generation)
      if (this.generation !== generation) throw new Error("Sync session changed; try again")
    } catch (error) { this.pauseCompatibility(error, generation); throw error }
  }

  private notifyRemoteChanges(
    event: unknown,
    requirePull = false,
    presentation: "foreground" | "background" = "background"
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
      if (typeof doc._id !== "string") return
      const change = {
        id: doc._id,
        doc,
        presentation
      }
      if (doc._id.startsWith("sto_")) {
        this.remoteChangeHandlers.forEach((handler) => handler(change))
      } else if (isTabSyncChangeId(doc._id)) {
        // Deletions arrive as `_deleted` stubs and are routed the same way.
        this.remoteTabChangeHandlers.forEach((handler) => handler(change))
      }
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
