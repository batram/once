import PouchDB from "pouchdb-browser"
import PouchDBFind from "pouchdb-find"
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
  IndexedDbCacheStore,
  keepIndexedDbOpenAfterAborts,
  LOCAL_POUCH_OPTIONS,
  PouchTabDocsDatabase,
  pouchTabDocs
} from "@once/persistence"
import { createFirefoxSyncConsent } from "./storage/WebExtSyncConsent"
import { deviceName } from "./deviceName"
import { WebExtSecretStorage } from "./storage/WebExtSecretStorage"
import { WebExtSyncStorage } from "./storage/WebExtSyncStorage"
import { setDocumentTheme } from "./ui/WebExtTheme"
import {
  createWebExtActiveTab,
  createWebExtHistorySubscription,
  createWebExtTabOpener
} from "./webextPorts"

PouchDB.plugin(PouchDBFind)

/** Which extension this is; without it the page runs without tab sync. */
export interface WebExtPlatformOptions {
  target: "chrome" | "firefox"
  appVersion: string
}

export function createWebExtPlatform(
  browserApi: typeof browser = browser,
  options?: WebExtPlatformOptions
): OncePlatformPorts {
  keepIndexedDbOpenAfterAborts()
  const onceDb = new PouchDB("once_db", LOCAL_POUCH_OPTIONS)
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
    // The URL arrives through the browser's own settings sync from other installations.
    syncUrlProvenance: "browser",
    ...(options?.target === "firefox" ? { syncConsent: createFirefoxSyncConsent(browserApi) } : {}),
    ...(options ? {
      tabDocs: pouchTabDocs(onceDb as unknown as PouchTabDocsDatabase),
      // The background publishes this browser's tabs, panel or not.
      device: { platform: options.target, defaultName: deviceName(options.target), appVersion: options.appVersion, sharesElsewhere: true }
    } : {}),
    secretStore: new WebExtSecretStorage(browserApi),
    theme: {
      setTheme: (theme: ThemeName) => setDocumentTheme(theme)
    },
    activeTab: createWebExtActiveTab(browserApi, window),
    tabOpener: createWebExtTabOpener(browserApi),
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
