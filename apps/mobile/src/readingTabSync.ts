import type { LocalWindow, TabOpenerPort, TabSourcePort } from "@once/app"
import type { ReadingTabs } from "./readingTabs"

/**
 * This phone's tabs for tab sync: one window, the reading tabs in order. A
 * Reader-mode tab is its page in reader mode; comments are a page like any.
 */
export function readingTabSource(tabs: () => ReadingTabs, capturePreview: () => Promise<void>): TabSourcePort {
  return {
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

/** Opens another device's tab as a new reading tab, in front or behind. */
export function readingTabOpener(open: () => (url: string, background: boolean) => void): TabOpenerPort {
  return { open: (url, { background }) => open()(url, background) }
}

async function imageSize(src: string): Promise<{ width: number; height: number }> {
  const image = new Image()
  image.src = src
  await image.decode()
  return { width: image.naturalWidth, height: image.naturalHeight }
}
