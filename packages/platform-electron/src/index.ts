import PouchDB from "pouchdb-browser"
import PouchDBFind from "pouchdb-find"
import { DatabaseChange, OncePlatformPorts, pageScriptSource, ThemeName } from "@once/app"
import { captureReaderPositionInPage } from "@once/app/tabsync"
import { Story } from "@once/core"
import {
  IndexedDbCacheStore,
  keepIndexedDbOpenAfterAborts,
  LOCAL_POUCH_OPTIONS,
  PouchListStore,
  PouchStoryStore,
  PouchSyncDatabase,
  PouchSyncService,
  PouchTabDocsDatabase,
  pouchTabDocs
} from "@once/persistence"
import { bridgeFetch, bridgeStreamingFetch } from "./fetch"
import { ElectronBridge, ElectronBuildInfo, ElectronTabState } from "./types"

export * from "./types"
export * from "./fetch"
export * from "./navigation"

PouchDB.plugin(PouchDBFind)

const OS_NAMES: Record<string, string> = { darwin: "macOS", win32: "Windows", linux: "Linux" }

export function createElectronPlatform(
  bridge: ElectronBridge,
  buildInfo?: ElectronBuildInfo
): OncePlatformPorts {
  const syncWindowBackground = () => {
    const color = getComputedStyle(document.body).backgroundColor
    void bridge.window.setBackgroundColor(color).catch((error) => {
      console.error("Failed to update Electron window background", error)
    })
  }
  window.matchMedia("(prefers-color-scheme: dark)")
    .addEventListener("change", syncWindowBackground)
  syncWindowBackground()

  keepIndexedDbOpenAfterAborts()
  const onceDb = new PouchDB("once_electron_v2", LOCAL_POUCH_OPTIONS)
  const fetchThroughMain = (input: RequestInfo | URL, init?: RequestInit) =>
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
    secretStore: {
      protection: "os",
      get: (key) => bridge.settings.getSecret(key),
      set: (key, value) => bridge.settings.setSecret(key, value)
    },
    theme: {
      setTheme(theme: ThemeName) {
        document.body.removeAttribute("data-theme")
        if (theme !== "system") {
          document.body.setAttribute("data-theme", theme)
        }
        syncWindowBackground()
      }
    },
    livePage: {
      html: (url) => bridge.tabs.pageHtml(url)
    },
    activeTab: {
      openUrl(url, target) {
        bridge.tabs.openUrl(url, target)
      },
      onSelectedUrlChanged(handler) {
        let lastSelection = ""
        const notify = (tabs: ElectronTabState[]) => {
          const active = tabs.find((tab) => tab.active)
          if (!active) return
          const selection = JSON.stringify([active.id, active.url, active.storyPage, active.loadError])
          if (selection !== lastSelection) {
            lastSelection = selection
            handler(active.url, { ...active.storyPage, failed: Boolean(active.loadError) })
          }
        }

        bridge.tabs.getAll().then(notify)
        return bridge.tabs.onChanged(notify)
      }
    },
    tabDocs: pouchTabDocs(onceDb as unknown as PouchTabDocsDatabase),
    tabSource: {
      snapshot: () => bridge.tabSync.snapshot(),
      onChanged: (handler) => bridge.tabSync.onChanged(handler),
      captureThumbnail: (tabId) => bridge.tabSync.capture(tabId),
      runInPage: async (tabId, call) => await bridge.tabSync.run(tabId, pageScriptSource(call)) as never,
      // The reader is a page in its tab here, so a page script reads it.
      readerPosition: async (tabId) =>
        await bridge.tabSync.run(tabId, pageScriptSource({ fn: captureReaderPositionInPage, args: [] })) as never,
      onDeselected: (handler) => bridge.tabSync.onDeselected(handler)
    },
    device: {
      platform: "electron",
      defaultName: `Once on ${OS_NAMES[buildInfo?.platform ?? ""] ?? "desktop"}`,
      appVersion: buildInfo?.version ?? ""
    },
    fetch: fetchThroughMain,
    // Addon connections stream, so a tray can show an answer as it is written.
    addonFetch: (input, init) => bridgeStreamingFetch(bridge, input, init),
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
