function createFakePlatform(stories = [], options = {}) {
  const lists = new Map()
  if (options.storySources) lists.set("story_sources", options.storySources)
  const savedStories = new Map(stories.map((story) => [story.href, story]))
  const cachedResponses = new Map(options.cachedResponses || [])
  let databaseHandler
  let remoteDatabaseHandler
  let historyHandler
  const opened = []

  return {
    opened,
    emitDatabaseChange(change) { databaseHandler?.(change) },
    emitRemoteDatabaseChange(change) { remoteDatabaseHandler?.(change) },
    emitHistory(action) { historyHandler?.(action) },
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
        async getCacheTime() { return 120 },
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
        async set(url, value) { cachedResponses.set(url, value) }
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
