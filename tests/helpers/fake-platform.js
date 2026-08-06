function createFakePlatform(stories = [], options = {}) {
  const lists = new Map()
  if (options.storySources) {
    const sources = Array.isArray(options.storySources)
      ? options.storySources.map((source, index) => typeof source === "string"
        ? { id: `src_test${String(index).padStart(8, "0")}`, url: source }
        : source)
      : options.storySources.sources
    lists.set("sources", Array.isArray(options.storySources)
      ? { version: 2, groups: [], sources }
      : options.storySources)
  }
  const savedStories = new Map(stories.map((story) => [story.href, story]))
  const cachedResponses = new Map(options.cachedResponses || [])
  let databaseHandler
  let remoteDatabaseHandler
  let historyHandler
  const opened = []

  return {
    opened,
    setStoredStory(story) { savedStories.set(story.href, story) },
    deleteStoredStory(href) { savedStories.delete(href) },
    emitDatabaseChange(change) { databaseHandler?.(change) },
    emitRemoteDatabaseChange(change) { remoteDatabaseHandler?.(change) },
    emitHistory(action) { historyHandler?.(action) },
    cachedResponses,
    ports: {
      listStore: {
        async get(id, fallback) {
          if (!lists.has(id)) lists.set(id, fallback)
          return lists.get(id)
        },
        async set(id, value) {
          lists.set(id, value)
          if (options.emitDatabaseChangesOnSet) {
            databaseHandler?.({ id, doc: { list: value } })
          }
        }
      },
      storyStore: {
        storyId: (url) => `sto_${url}`,
        async getStories(limit) {
          const stories = Array.from(savedStories.values())
          return limit === undefined ? stories : stories.slice(0, limit)
        },
        async getStaredStories() {
          return Array.from(savedStories.values()).filter((story) => story.stared)
        },
        async getStoriesByUrls(urls) {
          return new Map(urls.flatMap((url) => savedStories.has(url) ? [[url, savedStories.get(url)]] : []))
        },
        async getStory(url) { return savedStories.get(url) || null },
        async saveStory(story) {
          savedStories.set(story.href, story)
          return story
        }
      },
      syncSettingsStore: {
        async getSyncUrl() { return "" },
        async setSyncUrl() {},
        async getCacheTime() { return options.cacheTime ?? 60 },
        async setCacheTime() {}
      },
      syncService: {
        syncFrom() {},
        onRemoteChange(handler) {
          remoteDatabaseHandler = handler
          return () => { remoteDatabaseHandler = undefined }
        }
      },
      theme: { setTheme() {} },
      activeTab: {
        openUrl(url, target) { opened.push({ url, target }) },
        onSelectedUrlChanged() { return () => undefined }
      },
      cacheStore: {
        async get(url) { return cachedResponses.get(url) || null },
        async set(url, value) { cachedResponses.set(url, value) },
        async delete(url) { cachedResponses.delete(url) },
        async clear() { cachedResponses.clear() }
      },
      fetch: options.fetch || (async (url) => { throw new Error(`Unexpected network request in test: ${url}`) }),
      onDatabaseChange(handler) {
        databaseHandler = handler
        return () => { databaseHandler = undefined }
      },
      onHistoryCommand(handler) {
        historyHandler = handler
        return () => { historyHandler = undefined }
      }
    }
  }
}

module.exports = { createFakePlatform }
