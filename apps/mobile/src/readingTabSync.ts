import { pageScriptSource, type LocalWindow, type TabOpenerPort, type TabSourcePort } from "@once/app"
import { PanelNavigation } from "@once/ui-web"
import type { MobileReadingController } from "./readingController"
import type { ReadingTab, ReadingTabs } from "./readingTabs"

/**
 * This phone's tabs for tab sync: one window, the reading tabs in order. A
 * Reader-mode tab is its page in reader mode; comments are a page like any.
 */
export function readingTabSource(
  tabs: () => ReadingTabs,
  capturePreview: () => Promise<void>,
  evaluate: (tabId: string, script: string) => Promise<string | null>
): TabSourcePort {
  return {
    async runInPage(tabId, call) {
      const tab = tabs().tabs.find((entry) => entry.id === tabId)
      if (!tab || tab.session.snapshot().mode !== "browser" || tab.session.snapshot().loadState !== "ready") return null
      const value = await evaluate(tabId, `JSON.stringify(${pageScriptSource(call)})`).catch(() => null)
      return value ? decode(value) as never : null
    },
    readerPosition: async (tabId) => tabs().tabs.find((tab) => tab.id === tabId)?.readerPosition ?? null,
    onDeselected: (handler) => tabs().onDeselected(handler),
    /**
     * The tab view's own preview: refreshed for the selected tab while it
     * shows, kept from earlier for the others until they navigate.
     */
    async captureThumbnail(tabId) {
      const reading = tabs()
      if (reading.activeId === tabId) await capturePreview().catch(() => undefined)
      const preview = reading.tabs.find((tab) => tab.id === tabId)?.preview
      const match = preview && /^data:image\/jpeg;base64,(.+)$/.exec(preview)
      if (!match) return null
      const size = await imageSize(preview).catch(() => null)
      return size && { jpeg: match[1], ...size }
    },
    snapshot: async (): Promise<LocalWindow[]> => {
      const reading = tabs()
      return [{
        id: "mobile", focused: true,
        tabs: reading.tabs.flatMap((tab) => {
          const state = tab.session.snapshot()
          if (!state.currentUrl) return []
          return [{
            id: tab.id, url: state.currentUrl, title: tab.title || state.story?.title || "",
            mode: state.mode === "reader" ? "reader" as const : "web" as const,
            active: tab.id === reading.activeId, audible: tab.audio === "playing",
            storyId: state.story ? `sto_${state.story.href}` : undefined, ...tab.times
          }]
        })
      }]
    },
    onChanged: (handler) => tabs().subscribe(handler)
  }
}

/**
 * Opens another device's tab as a new reading tab, in front or behind,
 * where it was left: a Reader view at its block, a page with its script
 * run once loaded. The current page stays.
 */
export function readingTabOpener(reading: () => Pick<MobileReadingController, "tabs" | "runtime" | "tabDialog">): TabOpenerPort {
  return {
    open(url, { background, mode, restore, readerPosition }) {
      const { tabs, runtime, tabDialog } = reading()
      const tab = tabs.create(!background)
      if (mode === "reader") {
        tab.pendingReaderPosition = readerPosition
        tab.session.showHistoryEntry(url, "reader")
      } else {
        tab.session.navigate(url)
        if (restore) restoreWhenLoaded(tab, url, pageScriptSource(restore), (script) => runtime.evaluate(tab.id, script))
      }
      if (background) tabDialog.announce("Opened in background tab")
      else PanelNavigation.open_panel("reading")
    }
  }
}

/** The surface returns the script's JSON as a string, encoded once more by some engines. */
function decode(value: string): unknown {
  try {
    const decoded: unknown = JSON.parse(value)
    return typeof decoded === "string" ? JSON.parse(decoded) : decoded
  } catch {
    return null
  }
}

async function imageSize(src: string): Promise<{ width: number; height: number }> {
  const image = new Image()
  image.src = src
  await image.decode()
  return { width: image.naturalWidth, height: image.naturalHeight }
}

/**
 * Runs `script` once the tab has loaded `url`, for a minute at most: a
 * video's position from another device, sought once the player appears.
 */
export function restoreWhenLoaded(tab: ReadingTab, url: string, script: string, evaluate: (script: string) => Promise<unknown>): void {
  const until = Date.now() + 60_000
  let done = false
  // The listener can run before subscribe returns, so the release is kept in a holder.
  const subscription: { stop?: () => void } = {}
  subscription.stop = tab.session.subscribe((state) => {
    if (done) return
    const loaded = state.currentUrl === url && state.loadState === "ready"
    if (!loaded && Date.now() < until && state.mode === "browser") return
    done = true
    subscription.stop?.()
    if (loaded) void evaluate(script).catch(() => undefined)
  })
  if (done) subscription.stop()
}
