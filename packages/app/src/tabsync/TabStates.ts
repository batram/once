import {
  MEDIA_STATE,
  readMediaState,
  readReaderPosition,
  READER_STATE,
  ReaderPosition,
  SyncedTab,
  SyncedWindow,
  TabStateEntry,
  withYouTubeStart,
  isYouTubeVideo
} from "@once/core"
import type { PageScriptCall, TabSourcePort } from "../types"
import { captureMediaInPage, restoreMediaInPage, restoreReaderPositionInPage } from "./pageScripts"

interface Cached { navSeq: number; url: string; entries: Record<string, TabStateEntry>; changedAt: number }

/** Tabs whose state is read per sample: the selected and the playing ones, a few at most. */
const SAMPLED_TABS = 6

/**
 * The state of this device's tabs (video position, reading position), kept
 * apart from publication: it is updated whenever a tab is sampled or left,
 * and a publication reads it. Every entry belongs to one page (a tab's
 * navigation and URL), so a late result for a page already left is dropped.
 */
export class TabStates {
  private readonly cache = new Map<string, Cached>()

  constructor(private readonly source: TabSourcePort | undefined) {}

  /** Tabs worth sampling now: selected or audible. */
  sampled(windows: SyncedWindow[]): SyncedTab[] {
    return windows.flatMap((window) => window.tabs)
      .filter((tab) => tab.active || tab.audible)
      .slice(0, SAMPLED_TABS)
  }

  /** Reads one tab's state; true when it changed. */
  async capture(tab: Pick<SyncedTab, "id" | "navSeq" | "url" | "mode">): Promise<boolean> {
    const entries: Record<string, TabStateEntry> = {}
    const capturedAt = new Date().toISOString()
    if (tab.mode === "reader") {
      const position = readReaderPosition(await this.source?.readerPosition?.(tab.id).catch(() => null))
      if (position) entries[READER_STATE.id] = { v: READER_STATE.version, capturedAt, data: position }
    } else if (this.source?.runInPage) {
      const media = readMediaState(await this.source.runInPage(tab.id, { fn: captureMediaInPage, args: [] }).catch(() => null))
      if (media) entries[MEDIA_STATE.id] = { v: MEDIA_STATE.version, capturedAt, data: media }
    }
    const previous = this.cache.get(tab.id)
    const samePage = previous?.navSeq === tab.navSeq && previous.url === tab.url
    if (!Object.keys(entries).length) {
      // Nothing readable now (a page without media, a tab asleep): keep what was known for this page.
      if (!samePage) this.cache.delete(tab.id)
      return false
    }
    const changed = !samePage || JSON.stringify(dataOf(previous.entries)) !== JSON.stringify(dataOf(entries))
    this.cache.set(tab.id, {
      navSeq: tab.navSeq, url: tab.url, entries,
      changedAt: changed ? Date.now() : previous?.changedAt ?? Date.now()
    })
    return changed
  }

  /** The windows with each tab's known state; a change in state counts as use of the tab. */
  attach(windows: SyncedWindow[]): SyncedWindow[] {
    const open = new Set(windows.flatMap((window) => window.tabs.map((tab) => tab.id)))
    for (const id of this.cache.keys()) if (!open.has(id)) this.cache.delete(id)
    return windows.map((window) => ({
      ...window,
      tabs: window.tabs.map((tab) => {
        const cached = this.cache.get(tab.id)
        if (!cached || cached.navSeq !== tab.navSeq || cached.url !== tab.url) return tab
        const activity = Math.max(Date.parse(tab.activityAt) || 0, cached.changedAt)
        return { ...tab, state: { ...tab.state, ...cached.entries }, activityAt: new Date(activity).toISOString() }
      })
    }))
  }

  reset(): void {
    this.cache.clear()
  }
}

function dataOf(entries: Record<string, TabStateEntry>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(entries).map(([id, entry]) => [id, entry.data]))
}

/** How to open another device's tab where it was left. */
export interface RestorePlan {
  url: string
  restore?: PageScriptCall
  readerPosition?: ReaderPosition
}

/**
 * Turns a tab's state into an address and a script for the opened page.
 * YouTube takes its start time in the URL, which works before any script
 * can run; other media are sought once they appear; an article scrolls to
 * its saved block. Unknown or newer state is ignored here.
 */
export function restorePlan(url: string, mode: "web" | "reader", state: Record<string, TabStateEntry> | undefined): RestorePlan {
  const media = state?.[MEDIA_STATE.id]?.v === MEDIA_STATE.version ? readMediaState(state[MEDIA_STATE.id].data) : null
  if (media && mode === "web") {
    if (isYouTubeVideo(url)) return { url: withYouTubeStart(url, media.currentTime) }
    return { url, restore: { fn: restoreMediaInPage, args: [media.currentTime, media.rate] } }
  }
  const reader = state?.[READER_STATE.id]?.v === READER_STATE.version ? readReaderPosition(state[READER_STATE.id].data) : null
  if (reader && mode === "reader") {
    return {
      url, readerPosition: reader,
      restore: { fn: restoreReaderPositionInPage, args: [reader.fraction, reader.anchor?.index ?? -1, reader.anchor?.text ?? ""] }
    }
  }
  return { url }
}
