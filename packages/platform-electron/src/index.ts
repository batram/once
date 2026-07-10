import PouchDB from "pouchdb-browser"
import { DatabaseChange, OncePlatformPorts, ThemeName } from "@once/app"
import { Story } from "@once/core"
import {
  IndexedDbCacheStore,
  PouchListStore,
  PouchStoryStore,
  PouchSyncDatabase,
  PouchSyncService
} from "@once/persistence"
import { bridgeFetch } from "./fetch"
import { ElectronBridge, ElectronTabState } from "./types"

export * from "./types"
export * from "./fetch"
export * from "./navigation"

export function createElectronPlatform(
  bridge: ElectronBridge
): OncePlatformPorts {
  const onceDb = new PouchDB("once_electron_v2")
  const fetchThroughMain = (input: RequestInfo, init?: RequestInit) =>
    bridgeFetch(bridge, input, init)
  const listStore = new PouchListStore(onceDb)
  const storyStore = new PouchStoryStore(onceDb, (story) =>
    Story.from_obj(story)
  )
  const syncService = new PouchSyncService(
    onceDb as unknown as PouchSyncDatabase,
    (event) => console.log("change db", event),
    (url) =>
      new PouchDB(url, {
        fetch: fetchThroughMain
      }) as unknown as PouchSyncDatabase
  )

  return {
    listStore,
    storyStore,
    syncService,
    cacheStore: IndexedDbCacheStore,
    syncSettingsStore: bridge.settings,
    theme: {
      setTheme(theme: ThemeName) {
        document.body.removeAttribute("data-theme")
        if (theme !== "system") {
          document.body.setAttribute("data-theme", theme)
        }
      }
    },
    activeTab: {
      openUrl(url, target) {
        bridge.tabs.openUrl(url, target)
      },
      onSelectedUrlChanged(handler) {
        let lastUrl = ""
        const notify = (tabs: ElectronTabState[]) => {
          const active = tabs.find((tab) => tab.active)
          if (active && active.url !== lastUrl) {
            lastUrl = active.url
            handler(active.url)
          }
        }

        bridge.tabs.getAll().then(notify)
        return bridge.tabs.onChanged(notify)
      }
    },
    fetch: fetchThroughMain,
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

      return () => changes.cancel()
    }
  }
}
