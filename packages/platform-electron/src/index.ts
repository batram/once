import { createPdfTextPort } from "@once/platform-web/pdf"
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

/** Native helpers: Apple Vision on macOS, Windows.Media.Ocr on Windows. A request is cancelled in main when its signal aborts. */
function textRecognition(bridge: ElectronBridge): NonNullable<OncePlatformPorts["textRecognition"]> {
  return {
    async recognizeImage(bytes, signal) {
      signal?.throwIfAborted()
      const requestId = crypto.randomUUID()
      const cancel = () => { void bridge.cancelImageRecognition(requestId).catch(() => undefined) }
      signal?.addEventListener("abort", cancel, { once: true })
      try {
        const result = await bridge.recognizeImage(bytes, requestId)
        signal?.throwIfAborted()
        return result
      } finally { signal?.removeEventListener("abort", cancel) }
    }
  }
}

export interface ElectronPlatformOptions {
  /** The PDF sandbox page, served under `once-addon://pdf/`. */
  pdfSandboxUrl?: string
}

export function createElectronPlatform(
  bridge: ElectronBridge,
  buildInfo?: ElectronBuildInfo,
  options: ElectronPlatformOptions = {}
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
  const listStore = new PouchListStore(onceDb, version => syncService.requireSyncProtocol(version))
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
    textRecognition: buildInfo?.platform === "darwin" || buildInfo?.platform === "win32" ? textRecognition(bridge) : undefined,
    ...(options.pdfSandboxUrl ? { pdfText: createPdfTextPort({ sandboxUrl: options.pdfSandboxUrl }) } : {}),
    fetch: fetchThroughMain,
    // Document bodies stream from main so retrieval can stop at its byte cap;
    // the plain bridge fetch buffers a whole body in main first.
    documentFetch: (input, init) => bridgeStreamingFetch(bridge, input, init),
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
