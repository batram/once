import type { TabThumbnail } from "@once/app"

const KEY = "once:tabsync:thumbs"
const WIDTH = 320
/** Chrome allows two visible-tab captures a second. */
const MIN_GAP_MS = 600

interface Shot extends TabThumbnail { url: string }

/**
 * Screenshots for tab sync. A browser can only capture each window's visible
 * tab, so the active tab is captured when it is selected or finishes loading,
 * and the picture is kept in session storage, by tab and URL, for when the
 * tab is published later from the background. Private windows are never
 * captured.
 */
export function installTabSyncCapture(api: typeof browser): (tabId: string) => Promise<TabThumbnail | null> {
  const storage = api.storage.session
  let last = 0
  let chain: Promise<unknown> = Promise.resolve()

  const read = async (): Promise<Record<string, Shot>> => ((await storage.get(KEY))[KEY] as Record<string, Shot> | undefined) ?? {}
  const capture = (tab: browser.tabs.Tab): Promise<Shot | null> => {
    const run = chain.then(async () => {
      if (tab.id === undefined || tab.windowId === undefined || !tab.url || tab.incognito || !/^https?:/.test(tab.url)) return null
      const wait = last + MIN_GAP_MS - Date.now()
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait))
      last = Date.now()
      const current = await api.tabs.get(tab.id).catch(() => null)
      // Only the tab the window shows, once loaded, and still on the same page.
      if (!current?.active || current.status !== "complete" || current.url !== tab.url) return null
      const dataUrl = await api.tabs.captureVisibleTab(tab.windowId, { format: "jpeg", quality: 70 }).catch(() => null)
      if (!dataUrl) return null
      const shot = { url: tab.url, ...await shrink(dataUrl) }
      const shots = await read()
      shots[tab.id] = shot
      await storage.set({ [KEY]: shots })
      return shot
    })
    chain = run.catch(() => undefined)
    return run.catch(() => null)
  }
  const captureActive = (tabId: number) => {
    void api.tabs.get(tabId).then((tab) => capture(tab)).catch(() => undefined)
  }

  api.tabs.onActivated.addListener(({ tabId }) => { setTimeout(() => captureActive(tabId), 400) })
  api.tabs.onUpdated.addListener((tabId, change, tab) => {
    if (change.status === "complete" && tab.active) captureActive(tabId)
  })
  api.tabs.onRemoved.addListener((tabId) => {
    chain = chain.then(async () => {
      const shots = await read()
      await storage.set({ [KEY]: Object.fromEntries(Object.entries(shots).filter(([id]) => id !== String(tabId))) })
    }).catch(() => undefined)
  })

  return async (tabId) => {
    const tab = await api.tabs.get(Number(tabId)).catch(() => null)
    if (!tab?.url) return null
    const kept = (await read())[tabId]
    const shot = kept?.url === tab.url ? kept : await capture(tab)
    return shot && { jpeg: shot.jpeg, width: shot.width, height: shot.height }
  }
}

/** Scales a capture down to thumbnail width and keeps only its top, as other browsers do. */
async function shrink(dataUrl: string): Promise<TabThumbnail> {
  const bitmap = await createImageBitmap(await (await fetch(dataUrl)).blob())
  const width = Math.min(WIDTH, bitmap.width)
  const sourceHeight = Math.min(bitmap.height, Math.round(bitmap.width * 10 / 16))
  const height = Math.round(sourceHeight * width / bitmap.width)
  const canvas = new OffscreenCanvas(width, height)
  canvas.getContext("2d")?.drawImage(bitmap, 0, 0, bitmap.width, sourceHeight, 0, 0, width, height)
  bitmap.close()
  const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: 0.6 })
  const bytes = new Uint8Array(await blob.arrayBuffer())
  let binary = ""
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000))
  return { jpeg: btoa(binary), width, height }
}
