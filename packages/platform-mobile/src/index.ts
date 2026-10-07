import PouchDB from "pouchdb-browser"
import PouchDBFind from "pouchdb-find"
import { Browser } from "@capacitor/browser"
import { Capacitor, registerPlugin } from "@capacitor/core"
import { mobileAddonFetch } from "./addonFetch"
import { installNativeFetch, nativeFetch } from "./nativeFetch"
import { StatusBar, Style } from "@capacitor/status-bar"
import { DatabaseChange, OncePlatformPorts, TabOpenerPort, TabSourcePort, ThemeName } from "@once/app"
import { DEFAULT_CACHE_MINUTES, Story } from "@once/core"
import {
  IndexedDbCacheStore,
  LOCAL_POUCH_OPTIONS,
  PouchListStore,
  PouchStoryStore,
  PouchSyncDatabase,
  PouchSyncService,
  PouchTabDocsDatabase,
  pouchTabDocs
} from "@once/persistence"
export * from "./InAppBrowserSurface"
export * from "./ReadingUrl"
export * from "./BrowserExtensions"
export * from "./ViolentmonkeyHandOff"

PouchDB.plugin(PouchDBFind)

interface SecureSettingsPlugin {
  getSyncUrl(): Promise<{ value: string }>
  setSyncUrl(options: { value: string }): Promise<void>
  getSecret(options: { key: string }): Promise<{ value: string }>
  setSecret(options: { key: string; value: string }): Promise<void>
}

const SecureSettings = registerPlugin<SecureSettingsPlugin>("SecureSettings")

export interface MobileNativeBridge {
  getSyncUrl(): Promise<string>
  setSyncUrl(value: string): Promise<void>
  /** Kept with the sync URL, in the Keychain or Keystore-encrypted prefs. */
  getSecret(key: string): Promise<string>
  setSecret(key: string, value: string): Promise<void>
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
    return Number.isFinite(value) ? value : DEFAULT_CACHE_MINUTES
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
    async getSecret(key) {
      if (!Capacitor.isNativePlatform()) {
        return window.localStorage.getItem(`once:mobile:secret:${key}`) || ""
      }
      return (await SecureSettings.getSecret({ key })).value || ""
    },
    async setSecret(key, value) {
      if (!Capacitor.isNativePlatform()) {
        if (value) window.localStorage.setItem(`once:mobile:secret:${key}`, value)
        else window.localStorage.removeItem(`once:mobile:secret:${key}`)
        return
      }
      await SecureSettings.setSecret({ key, value })
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
      // Capacitor Style.Dark = dark background (light text), Style.Light = light background
      await StatusBar.setStyle({ style: dark ? Style.Dark : Style.Light })
      if (Capacitor.getPlatform() === "android") {
        await StatusBar.setBackgroundColor({ color: dark ? "#282a36" : "#f6f6ef" })
      }
    }
  }
}

export interface MobilePlatformOptions {
  /**
   * Shows an http(s) page inside the app's reading view. Links opened with a
   * "_self" or "current" target go here; "blank" and "middle" are the user's
   * explicit choice of the system browser and stay external.
   */
  openInApp?: (url: string) => void
  /** The app's version, which other devices show for this one. */
  appVersion?: string
  /** The reading tabs this device shares, and where another device's tab opens. */
  tabSource?: TabSourcePort
  tabOpener?: TabOpenerPort
}

export function createMobilePlatform(
  bridge: MobileNativeBridge = createDefaultMobileNativeBridge(),
  database?: PouchDB.Database,
  options: MobilePlatformOptions = {}
): OncePlatformPorts {
  installNativeFetch()
  const onceDb = database || new PouchDB("once_mobile_v1", LOCAL_POUCH_OPTIONS)
  const listStore = new PouchListStore(onceDb)
  const storyStore = new PouchStoryStore(onceDb, (story) => Story.from_obj(story))
  const syncService = new PouchSyncService(
    onceDb as unknown as PouchSyncDatabase,
    (event) => console.debug("mobile database changed", event),
    // pouchdb-fetch keeps the global fetch it saw at load time, before
    // installNativeFetch ran, so the remote is handed nativeFetch directly.
    (url) => new PouchDB(url, { fetch: nativeFetch }) as unknown as PouchSyncDatabase
  )

  return {
    listStore,
    storyStore,
    syncService,
    cacheStore: IndexedDbCacheStore,
    syncSettingsStore: new MobileSyncSettingsStore(bridge),
    secretStore: {
      ...(Capacitor.isNativePlatform() ? { protection: "os" as const } : {}),
      get: (key) => bridge.getSecret(key),
      set: (key, value) => bridge.setSecret(key, value)
    },
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
      openUrl(url, target) {
        if (!/^https?:\/\//i.test(url)) return
        if ((target === "_self" || target === "current") && options.openInApp) {
          options.openInApp(url)
          return
        }
        void bridge.openExternal(url).catch((error) => {
          console.error("Failed to open mobile browser", error)
        })
      },
      onSelectedUrlChanged() {
        return () => undefined
      }
    },
    tabDocs: pouchTabDocs(onceDb as unknown as PouchTabDocsDatabase),
    tabSource: options.tabSource,
    tabOpener: options.tabOpener,
    device: mobileDevice(options.appVersion ?? ""),
    fetch: nativeFetch,
    addonFetch: mobileAddonFetch,
    onDatabaseChange(handler) {
      const changes = onceDb
        .changes({ since: "now", live: true, include_docs: true })
        .on("change", (change) => handler(change as unknown as DatabaseChange))
      return () => changes.cancel()
    }
  }
}

/** What other devices call this one until the user names it. */
function mobileDevice(appVersion: string): NonNullable<OncePlatformPorts["device"]> {
  const ios = Capacitor.getPlatform() === "ios" || (!Capacitor.isNativePlatform() && /iPhone|iPad/.test(navigator.userAgent))
  const tablet = /iPad/.test(navigator.userAgent) || (ios && navigator.maxTouchPoints > 1 && !/iPhone/.test(navigator.userAgent))
  return {
    platform: ios ? "ios" : "android",
    defaultName: ios ? (tablet ? "iPad" : "iPhone") : "Android",
    appVersion
  }
}
