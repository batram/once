import { DEFAULT_CACHE_MINUTES } from "@once/core"

export class WebExtSyncStorage {
  constructor(private browserApi: typeof browser = browser) {}

  async getSyncUrl(): Promise<string> {
    const data = await this.browserApi.storage.sync.get("sync_url")
    return typeof data?.sync_url === "string" ? data.sync_url : ""
  }

  async setSyncUrl(syncUrl: string): Promise<void> {
    await this.browserApi.storage.sync.set({ sync_url: syncUrl })
  }

  async getCacheTime(): Promise<number> {
    const data = await this.browserApi.storage.sync.get("cache_time")
    const time = parseInt(data.cache_time)
    return data && !Number.isNaN(time) ? time : DEFAULT_CACHE_MINUTES
  }

  async setCacheTime(cacheTime: string): Promise<void> {
    await this.browserApi.storage.sync.set({ cache_time: cacheTime })
  }
}
