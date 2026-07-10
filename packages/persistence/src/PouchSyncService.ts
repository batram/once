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

  constructor(
    private db: PouchSyncDatabase,
    private onChange: (event: unknown) => void,
    private createRemote: (url: string) => string | PouchSyncDatabase = (url) =>
      url
  ) {}

  syncFrom(couchdbUrl: string): void {
    const syncOps = {
      live: true,
      retry: true,
      batch_size: 100
    }

    this.initialReplication?.cancel?.()
    this.syncHandler?.cancel?.()
    this.syncHandler = undefined

    const remote = this.createRemote(couchdbUrl)
    const initialReplication = this.db.replicate.from(remote)
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
          })
          .on("denied", (err: unknown) => {
            console.error("pouch denied", err)
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
      })
  }
}
