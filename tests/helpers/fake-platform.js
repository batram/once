const { Story } = require("../../packages/core/dist")

// Like the real store: every read and write is a copy, never the caller's object.
function copyStory(story) {
  return typeof story?.to_obj === "function" ? Story.from_obj(story.to_obj()) : structuredClone(story)
}

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
  const savedStories = new Map(stories.map((story) => [story.href, copyStory(story)]))
  const savedContents = new Map(options.storyContents || [])
  const cachedResponses = new Map(options.cachedResponses || [])
  const secrets = new Map(options.secrets || [])
  // Sets, like the real ports: the app subscribes to database changes from
  // more than one place, and a single slot would silently drop all but the last.
  const databaseHandlers = new Set()
  const remoteDatabaseHandlers = new Set()
  const historyHandlers = new Set()
  const subscribe = (handlers) => (handler) => {
    handlers.add(handler)
    return () => { handlers.delete(handler) }
  }
  const emit = (handlers, value) => { for (const handler of [...handlers]) handler(value) }
  const opened = []

  return {
    opened,
    setStoredStory(story) { savedStories.set(story.href, copyStory(story)) },
    savedContents,
    emitDatabaseChange(change) { emit(databaseHandlers, change) },
    emitRemoteDatabaseChange(change) { emit(remoteDatabaseHandlers, change) },
    emitHistory(action) { emit(historyHandlers, action) },
    cachedResponses,
    secrets,
    ports: {
      listStore: {
        async get(id, fallback) {
          if (!lists.has(id)) lists.set(id, fallback)
          return lists.get(id)
        },
        async set(id, value) {
          lists.set(id, value)
          if (options.emitDatabaseChangesOnSet) {
            emit(databaseHandlers, { id, doc: { list: value } })
          }
        }
      },
      storyStore: {
        storyId: (url) => `sto_${url}`,
        async getStories(limit) {
          const stories = Array.from(savedStories.values(), copyStory)
          return limit === undefined ? stories : stories.slice(0, limit)
        },
        async getStaredStories() {
          return Array.from(savedStories.values()).filter((story) => story.stared).map(copyStory)
        },
        async getStoriesByUrls(urls) {
          return new Map(urls.flatMap((url) => savedStories.has(url) ? [[url, copyStory(savedStories.get(url))]] : []))
        },
        async getStory(url) { return savedStories.has(url) ? copyStory(savedStories.get(url)) : null },
        async saveStory(story) {
          // Like PouchDB: pending html becomes the attachment, and the story
          // keeps only a stub describing it.
          const html = story.pendingContent?.()
          if (html !== undefined) {
            savedContents.set(story.href, html)
            story._attachments = {
              content: { content_type: "text/html", length: Buffer.byteLength(html), stub: true }
            }
          } else if (savedContents.has(story.href)) {
            story._attachments = {
              content: { content_type: "text/html", length: Buffer.byteLength(savedContents.get(story.href)), stub: true }
            }
          }
          savedStories.set(story.href, copyStory(story))
          return story
        },
        async deleteStory(url) {
          savedStories.delete(url)
          savedContents.delete(url)
        },
        async getStoryContent(url) { return savedContents.get(url) ?? null }
      },
      syncSettingsStore: {
        async getSyncUrl() { return "" },
        async setSyncUrl() {},
        async getCacheTime() { return options.cacheTime ?? 60 },
        async setCacheTime() {}
      },
      // Absent when a test says so, to see what a shell without one reports.
      secretStore: options.secretStore === false ? undefined : {
        async get(key) { return secrets.get(key) || "" },
        async set(key, value) { if (value) secrets.set(key, value); else secrets.delete(key) }
      },
      syncService: {
        syncFrom() {},
        onRemoteChange: subscribe(remoteDatabaseHandlers)
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
      onDatabaseChange: subscribe(databaseHandlers),
      onHistoryCommand: subscribe(historyHandlers)
    }
  }
}

module.exports = { createFakePlatform }
