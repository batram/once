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
  PouchSyncService
} from "@once/persistence"
import { CacheStore } from "./storage/CacheStore"
import { WebExtSyncStorage } from "./storage/WebExtSyncStorage"
import { setDocumentTheme } from "./ui/WebExtTheme"

export function createWebExtPlatform(): OncePlatformPorts {
  const onceDb = new PouchDB("once_db")
  const listStore = new PouchListStore(onceDb)
  const storyStore = new PouchStoryStore(onceDb, (story) =>
    Story.from_obj(story)
  )
  const syncService = new PouchSyncService(
    onceDb as unknown as PouchSyncService["db"],
    (event) => {
      console.log("change db", event)
    }
  )
  const syncSettingsStore = new WebExtSyncStorage()

  return {
    listStore,
    storyStore,
    syncService,
    cacheStore: CacheStore,
    syncSettingsStore,
    theme: {
      setTheme: (theme: ThemeName) => setDocumentTheme(theme)
    },
    activeTab: {
      openUrl(url, target) {
        if (target === "middle") {
          return
        }
        if (target === "_self") {
          browser.tabs.create({
            url,
            active: true
          })
          return
        }
        window.open(url, target)
      },
      onSelectedUrlChanged(handler) {
        const activatedListener = async (activeInfo: browser.tabs._OnActivatedActiveInfo) => {
          const win = await browser.windows.getCurrent()
          const tab = await browser.tabs.get(activeInfo.tabId)
          if (tab.windowId == win.id) {
            handler(tab.url)
          }
        }

        const updatedListener = async (
          _tabId: number,
          _changeInfo: browser.tabs._OnUpdatedChangeInfo,
          tab: browser.tabs.Tab
        ) => {
          const currentWindow = await browser.windows.getCurrent()
          if (tab.active && tab.windowId == currentWindow.id) {
            handler(tab.url)
          }
        }

        browser.tabs.onActivated.addListener(activatedListener)
        browser.tabs.onUpdated.addListener(updatedListener)

        return () => {
          browser.tabs.onActivated.removeListener(activatedListener)
          browser.tabs.onUpdated.removeListener(updatedListener)
        }
      }
    },
    fetch: window.fetch.bind(window),
    onHistoryCommand(handler) {
      const listener = (
        message: { onceCommand?: string; action?: "undo" | "redo" }
      ) => {
        if (
          message?.onceCommand === "history" &&
          (message.action === "undo" || message.action === "redo")
        ) {
          handler(message.action)
        }
      }

      browser.runtime.onMessage.addListener(listener)
      return () => {
        browser.runtime.onMessage.removeListener(listener)
      }
    },
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
