import { createPdfTextPort } from "@once/platform-web/pdf"
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
  syncFetchDiagnostics,
  IndexedDbCacheStore,
  protectRemoteAttachments,
  keepIndexedDbOpenAfterAborts,
  LOCAL_POUCH_OPTIONS,
  openLocalDatabase,
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
  const local = openLocalDatabase("once_db", (name) => new PouchDB(name, LOCAL_POUCH_OPTIONS))
  const onceDb = local.db
  const listStore = new PouchListStore(onceDb, version => syncService.requireSyncProtocol(version))
  const storyStore = new PouchStoryStore(onceDb, (story) =>
    Story.from_obj(story)
  )
  const syncService = new PouchSyncService(
    onceDb as unknown as PouchSyncService["db"],
    (event) => {
      console.log("change db", event)
    },
    (url) => protectRemoteAttachments(new PouchDB(url, { fetch: syncFetchDiagnostics(window.fetch.bind(window)) })) as unknown as PouchSyncService["db"],
    undefined,
    local.epoch
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
    pdfText: createPdfTextPort({ sandboxUrl: browserApi.runtime.getURL("static/pdf-sandbox.html") }),
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
