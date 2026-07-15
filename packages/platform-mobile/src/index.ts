import PouchDB from "pouchdb-browser"
import { Browser } from "@capacitor/browser"
import { Capacitor, registerPlugin } from "@capacitor/core"
import { StatusBar, Style } from "@capacitor/status-bar"
import { DatabaseChange, OncePlatformPorts, ThemeName } from "@once/app"
import { Story } from "@once/core"
import {
  IndexedDbCacheStore,
  PouchListStore,
  PouchStoryStore,
  PouchSyncDatabase,
  PouchSyncService
} from "@once/persistence"

interface SecureSettingsPlugin {
  getSyncUrl(): Promise<{ value: string }>
  setSyncUrl(options: { value: string }): Promise<void>
}

const SecureSettings = registerPlugin<SecureSettingsPlugin>("SecureSettings")

export interface MobileNativeBridge {
  getSyncUrl(): Promise<string>
  setSyncUrl(value: string): Promise<void>
  openExternal(url: string): Promise<void>
  setSystemTheme(theme: ThemeName): Promise<void>
}

class MobileSyncSettingsStore {
  constructor(private readonly bridge: MobileNativeBridge) {}

  getSyncUrl(): Promise<string> {
    return this.bridge.getSyncUrl()
  }

  setSyncUrl(syncUrl: string): Promise<void> {
    return this.bridge.setSyncUrl(syncUrl)
  }

  async getCacheTime(): Promise<number> {
    const stored = window.localStorage.getItem("once:mobile:cache-time")
    const value = Number.parseInt(stored || "", 10)
    return Number.isFinite(value) ? value : 120
  }

  async setCacheTime(cacheTime: string): Promise<void> {
    window.localStorage.setItem("once:mobile:cache-time", cacheTime)
  }
}

export function createDefaultMobileNativeBridge(): MobileNativeBridge {
  const fallbackKey = "once:mobile:sync-url"
  return {
    async getSyncUrl() {
      if (!Capacitor.isNativePlatform()) {
        return window.localStorage.getItem(fallbackKey) || ""
      }
      return (await SecureSettings.getSyncUrl()).value || ""
    },
    async setSyncUrl(value) {
      if (!Capacitor.isNativePlatform()) {
        if (value) window.localStorage.setItem(fallbackKey, value)
        else window.localStorage.removeItem(fallbackKey)
        return
      }
      await SecureSettings.setSyncUrl({ value })
    },
    async openExternal(url) {
      if (Capacitor.isNativePlatform()) {
        await Browser.open({ url })
      } else {
        window.open(url, "_blank", "noopener,noreferrer")
      }
    },
    async setSystemTheme(theme) {
      if (!Capacitor.isNativePlatform()) return
      const dark = theme === "dark" || (
        theme === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches
      )
      await StatusBar.setStyle({ style: dark ? Style.Light : Style.Dark })
      if (Capacitor.getPlatform() === "android") {
        await StatusBar.setBackgroundColor({ color: dark ? "#17191c" : "#ffffff" })
      }
    }
  }
}

export function createMobilePlatform(
  bridge: MobileNativeBridge = createDefaultMobileNativeBridge(),
  database?: PouchDB.Database
): OncePlatformPorts {
  const onceDb = database || new PouchDB("once_mobile_v1")
  const listStore = new PouchListStore(onceDb)
  const storyStore = new PouchStoryStore(onceDb, (story) => Story.from_obj(story))
  const syncService = new PouchSyncService(
    onceDb as unknown as PouchSyncDatabase,
    (event) => console.debug("mobile database changed", event),
    (url) => new PouchDB(url) as unknown as PouchSyncDatabase
  )

  return {
    listStore,
    storyStore,
    syncService,
    cacheStore: IndexedDbCacheStore,
    syncSettingsStore: new MobileSyncSettingsStore(bridge),
    theme: {
      setTheme(theme) {
        document.body.removeAttribute("data-theme")
        if (theme !== "system") document.body.setAttribute("data-theme", theme)
        void bridge.setSystemTheme(theme).catch((error) => {
          console.error("Failed to update mobile system bars", error)
        })
      }
    },
    activeTab: {
      openUrl(url) {
        if (!/^https?:\/\//i.test(url)) return
        void bridge.openExternal(url).catch((error) => {
          console.error("Failed to open mobile browser", error)
        })
      },
      onSelectedUrlChanged() {
        return () => undefined
      }
    },
    fetch: window.fetch.bind(window),
    onDatabaseChange(handler) {
      const changes = onceDb
        .changes({ since: "now", live: true, include_docs: true })
        .on("change", (change) => handler(change as unknown as DatabaseChange))
      return () => changes.cancel()
    }
  }
}
