export interface PouchEventChain {
  cancel?: () => void
  on(event: string, handler: (...args: unknown[]) => void): PouchEventChain
}

export interface PouchSyncDatabase {
  replicate: {
    from(url: string): PouchEventChain
  }
  sync(url: string, options: Record<string, unknown>): PouchEventChain
}

export class PouchSyncService {
  private syncHandler?: PouchEventChain

  constructor(
    private db: PouchSyncDatabase,
    private onChange: (event: unknown) => void
  ) {}

  syncFrom(couchdbUrl: string): void {
    const syncOps = {
      live: true,
      retry: true,
      batch_size: 100
    }

    if (this.syncHandler) {
      this.syncHandler.cancel?.()
    }

    this.db.replicate
      .from(couchdbUrl)
      .on("complete", (info: unknown) => {
        console.log("complete info replicate", info)
        if (!this.syncHandler) {
          this.syncHandler = this.db.sync(couchdbUrl, syncOps)
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
        }
      })
      .on("error", (e: unknown) => {
        console.error("pouch sync error", e)
      })
  }
}
