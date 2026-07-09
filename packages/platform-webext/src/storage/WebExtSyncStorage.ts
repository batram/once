export class WebExtSyncStorage {
  async getSyncUrl(): Promise<string> {
    const data = await browser.storage.sync.get("sync_url")
    return data ? data.sync_url : ""
  }

  async setSyncUrl(syncUrl: string): Promise<void> {
    await browser.storage.sync.set({ sync_url: syncUrl })
  }

  async getCacheTime(): Promise<number> {
    const data = await browser.storage.sync.get("cache_time")
    const time = parseInt(data.cache_time)
    return data && !Number.isNaN(time) ? time : 120
  }

  async setCacheTime(cacheTime: string): Promise<void> {
    await browser.storage.sync.set({ cache_time: cacheTime })
  }
}
