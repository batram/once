import PouchDB from "pouchdb-browser"
import { Story } from "@once/core"
import {
  DatabaseChange,
  OncePlatformPorts,
  ThemeName
} from "@once/app"
import {
  PouchListStore,
  PouchStoryStore,
  PouchSyncService,
  IndexedDbCacheStore
} from "@once/persistence"
import { WebExtSyncStorage } from "./storage/WebExtSyncStorage"
import { setDocumentTheme } from "./ui/WebExtTheme"
import {
  createWebExtActiveTab,
  createWebExtHistorySubscription
} from "./webextPorts"

export function createWebExtPlatform(
  browserApi: typeof browser = browser
): OncePlatformPorts {
  const onceDb = new PouchDB("once_db")
  const listStore = new PouchListStore(onceDb)
  const storyStore = new PouchStoryStore(onceDb, (story) =>
    Story.from_obj(story)
  )
  const syncService = new PouchSyncService(
    onceDb as unknown as PouchSyncService["db"],
    (event) => {
      console.log("change db", event)
    },
    (url) => new PouchDB(url) as unknown as PouchSyncService["db"]
  )
  const syncSettingsStore = new WebExtSyncStorage(browserApi)

  return {
    listStore,
    storyStore,
    syncService,
    cacheStore: IndexedDbCacheStore,
    syncSettingsStore,
    theme: {
      setTheme: (theme: ThemeName) => setDocumentTheme(theme)
    },
    activeTab: createWebExtActiveTab(browserApi, window),
    fetch: window.fetch.bind(window),
    onHistoryCommand: createWebExtHistorySubscription(browserApi),
    onDatabaseChange(handler) {
      const changes = onceDb
        .changes({
          since: "now",
          live: true,
          include_docs: true
        })
        .on("change", (change) => {
          handler(change as unknown as DatabaseChange)
        })

      return () => {
        changes.cancel()
      }
    }
  }
}
