export interface PouchSyncDatabase<TDoc> {
  replicate: {
    from(url: string): any
  }
  sync(url: string, options: Record<string, unknown>): any
}

export class PouchSyncService<TDoc> {
  private syncHandler: any

  constructor(
    private db: PouchSyncDatabase<TDoc>,
    private onChange: (event: unknown) => void
  ) {}

  syncFrom(couchdbUrl: string): void {
    const syncOps = {
      live: true,
      retry: true,
      batch_size: 100
    }

    if (this.syncHandler) {
      this.syncHandler.cancel()
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
            .on("error", (err: Error) => {
              console.error("pouch err", err)
            })
            .on("denied", (err: Error) => {
              console.error("pouch denied", err)
            })
            .on("paused", () => {
              console.info("pouch paused")
            })
        }
      })
      .on("error", (e: Error) => {
        console.error("pouch sync error", e)
      })
  }
}
