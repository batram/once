import { readReaderPosition, Story, type ReaderPosition } from "@once/core"
import { ReadingSession } from "@once/ui-web"
import type { ReadingSessionState } from "@once/ui-web"
import { ReadingHistory } from "./readingHistory"
type ReadingMode = ReadingSessionState["mode"]

const STORAGE_KEY = "once:mobile-reading-tabs:v1"
interface SavedTab {
  id: string
  url: string
  title: string
  mode: ReadingMode
  story: Record<string, unknown> | null
  readerScroll: number
  /** Absent in tabs saved before tab sync; a restored tab then starts now. */
  times?: TabTimes
  readerPosition?: ReaderPosition
}
/** What tab sync publishes about a tab's life: its navigation, and when it was opened, navigated, selected, used. */
export interface TabTimes { navSeq: number; openedAt: number; navigatedAt: number; selectedAt: number; activityAt: number }
export interface ReadingTab {
  readonly id: string
  readonly generation: string
  readonly session: ReadingSession
  /** Back/forward as the reader sees it, Reader-mode entries included. */
  readonly history: ReadingHistory
  title: string
  readerScroll: number
  restored: boolean
  preview?: string
  /** Audio this session: playing now, or played earlier and since stopped. */
  audio?: "playing" | "played"
  times: TabTimes
  /** How far the article is read, by block; travels to other devices. */
  readerPosition?: ReaderPosition
  /** A position from another device, applied when the reader opens and then forgotten. */
  pendingReaderPosition?: ReaderPosition
}
interface Snapshot { version: 1; activeId: string | null; tabs: SavedTab[] }

/** Owns metadata independently of feed membership and native runtime lifetime. */
export class ReadingTabs {
  private entries: ReadingTab[] = []
  private active: string | null = null
  private listeners = new Set<() => void>()
  private readonly deselected = new Set<(id: string) => void>()
  private removers = new Map<string, () => void>()
  private restoring = false
  private batching = false
  private batchChanged = false
  private persistTimer: ReturnType<typeof setTimeout> | undefined
  private closed: Snapshot | null = null
  // The selection a close left behind; any other selection was the user's own since.
  private selectionAfterClose: string | null = null
  private storage: Pick<Storage, "getItem" | "setItem"> | undefined

  constructor(storage?: Pick<Storage, "getItem" | "setItem">) {
    try { this.storage = storage ?? globalThis.localStorage } catch { /* storage is optional */ }
    try {
      const raw = this.storage?.getItem(STORAGE_KEY)
      if (raw) { this.restoring = true; this.restore(JSON.parse(raw)); this.restoring = false }
    } catch { this.restoring = false /* malformed or unavailable storage starts with no tabs */ }
    // Scroll positions are saved lazily; write them out before the app is suspended.
    globalThis.addEventListener?.("pagehide", () => this.persist())
    globalThis.document?.addEventListener("visibilitychange", () => { if (document.hidden) this.persist() })
  }

  get tabs(): readonly ReadingTab[] { return this.entries }
  get activeId(): string | null { return this.active }
  get selected(): ReadingTab | undefined { return this.entries.find(tab => tab.id === this.active) }
  get canUndo(): boolean { return this.closed !== null }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    listener()
    return () => this.listeners.delete(listener)
  }

  create(select = true, id: string = crypto.randomUUID(), generation?: string): ReadingTab {
    const tab = this.make(id, generation)
    this.entries.push(tab)
    if (select) this.choose(tab)
    this.publish()
    return tab
  }

  select(id: string): void {
    const tab = this.entries.find(entry => entry.id === id)
    if (!tab) return
    this.choose(tab)
    this.publish()
  }

  private choose(tab: ReadingTab): void {
    if (this.active !== tab.id) {
      tab.times.selectedAt = tab.times.activityAt = Date.now()
      const left = this.active
      if (left) this.deselected.forEach(listener => listener(left))
    }
    this.active = tab.id
  }

  /** Told when a tab stops being the selected one, while its page is still there. */
  onDeselected(listener: (id: string) => void): () => void {
    this.deselected.add(listener)
    return () => this.deselected.delete(listener)
  }

  close(id: string): void {
    const index = this.entries.findIndex(tab => tab.id === id)
    if (index < 0) return
    this.closed = this.snapshot()
    this.removers.get(id)?.()
    this.removers.delete(id)
    this.entries.splice(index, 1)
    if (this.active === id) this.active = this.entries[Math.max(0, index - 1)]?.id ?? null
    this.selectionAfterClose = this.active
    this.publish()
  }

  closeAll(): void {
    if (!this.entries.length) return
    this.closed = this.snapshot()
    for (const remove of this.removers.values()) remove()
    this.removers.clear()
    this.entries = []
    this.active = null
    this.selectionAfterClose = null
    this.publish()
  }

  undo(): void {
    if (!this.closed) return
    this.restoring = true
    const saved = this.closed
    this.closed = null
    // Keep surviving runtimes, and recreate only the pages actually destroyed.
    const existing = new Map(this.entries.map(tab => [tab.id, tab]))
    this.entries = saved.tabs.map(value => existing.get(value.id) ?? this.fromSaved(value))
    for (const tab of existing.values()) if (!this.entries.includes(tab)) this.entries.push(tab)
    if (this.active === this.selectionAfterClose) this.active = saved.activeId
    this.restoring = false
    this.publish()
  }

  refreshStories(stories: Story[]): void {
    // Every tab's session republishes; coalesce them into one tab update.
    this.batching = true
    try { for (const tab of this.entries) tab.session.setVisibleStories(stories) } finally { this.batching = false }
    if (this.batchChanged) { this.batchChanged = false; this.publish() }
  }

  setPreview(id: string, generation: string, url: string, preview: string): void {
    const tab = this.entries.find(entry => entry.id === id && entry.generation === generation)
    if (!tab || tab.session.snapshot().currentUrl !== url || !/^data:image\/jpeg;base64,/.test(preview)) return
    tab.preview = preview
    this.listeners.forEach(listener => listener())
  }

  setAudio(id: string, generation: string, playing: boolean): void {
    const tab = this.entries.find(entry => entry.id === id && entry.generation === generation)
    if (!tab) return
    const audio = playing ? "playing" : tab.audio && "played"
    if (playing) tab.times.activityAt = Date.now()
    if (audio === tab.audio) return
    tab.audio = audio
    this.listeners.forEach(listener => listener())
  }

  update(id: string, generation: string, value: { title?: string; readerScroll?: number; readerPosition?: ReaderPosition }): void {
    const tab = this.entries.find(entry => entry.id === id && entry.generation === generation)
    if (!tab) return
    if (value.readerScroll !== undefined && Number.isFinite(value.readerScroll)) {
      tab.readerScroll = Math.max(0, value.readerScroll)
      tab.times.activityAt = Date.now()
    }
    if (value.readerPosition) {
      tab.readerPosition = value.readerPosition
      tab.pendingReaderPosition = undefined
    }
    // Reader scroll reports arrive continuously and nothing renders them.
    if (value.title === undefined) { this.persistSoon(); return }
    tab.title = value.title
    this.publish()
  }

  private make(id: string, generation: string = crypto.randomUUID()): ReadingTab {
    const now = Date.now()
    const tab: ReadingTab = { id, generation, session: new ReadingSession(true), history: new ReadingHistory(), title: "", readerScroll: 0, restored: false,
      times: { navSeq: 0, openedAt: now, navigatedAt: now, selectedAt: now, activityAt: now } }
    let initial = true
    let previousUrl = ""
    let previousNavigation = 0
    this.removers.set(id, tab.session.subscribe(state => {
      tab.history.observe(state.mode, state.currentUrl)
      // Only a new document resets; same-document history (pushState) keeps it.
      const newDocument = !state.currentUrl || state.loadState === "loading" || state.navigationId !== previousNavigation
      if (state.currentUrl !== previousUrl && newDocument) {
        tab.title = ""
        tab.preview = undefined
        tab.readerScroll = 0
        tab.readerPosition = undefined
        if (!this.restoring) {
          tab.times.navSeq++
          tab.times.navigatedAt = tab.times.activityAt = Date.now()
        }
      }
      previousUrl = state.currentUrl
      previousNavigation = state.navigationId
      if (!initial) this.publish()
    }))
    initial = false
    return tab
  }

  private fromSaved(value: SavedTab): ReadingTab {
    const tab = this.make(value.id)
    tab.restored = true
    tab.session.restore({ story: value.story ? Story.from_obj(value.story) : null, mode: value.mode, currentUrl: value.url })
    tab.title = value.title
    tab.readerScroll = value.readerScroll
    if (value.times) tab.times = { ...value.times }
    if (value.readerPosition) tab.readerPosition = value.readerPosition
    return tab
  }

  private restore(raw: unknown): void {
    if (!raw || typeof raw !== "object") return
    const value = raw as Snapshot
    if (value.version !== 1 || !Array.isArray(value.tabs)) return
    const ids = new Set<string>()
    const validated: SavedTab[] = []
    for (const tab of value.tabs) {
      if (!tab || typeof tab.id !== "string" || !tab.id || ids.has(tab.id) || typeof tab.title !== "string" || typeof tab.url !== "string") continue
      if (tab.url && !/^https?:\/\//i.test(tab.url)) continue
      if (!["reader", "browser", "comments"].includes(tab.mode)) continue
      if (tab.story) { try { Story.from_obj(tab.story) } catch { continue } }
      ids.add(tab.id)
      validated.push({ ...tab, readerScroll: Number.isFinite(tab.readerScroll) ? Math.max(0, tab.readerScroll) : 0, times: readTimes(tab.times),
        readerPosition: readReaderPosition(tab.readerPosition) ?? undefined })
    }
    this.entries = validated.map(tab => this.fromSaved(tab))
    this.active = value.activeId === null || ids.has(value.activeId ?? "") ? value.activeId : this.entries[0]?.id ?? null
  }

  private snapshot(): Snapshot {
    return { version: 1, activeId: this.active, tabs: this.entries.map(tab => {
      const state = tab.session.snapshot()
      const story = state.story
      return { id: tab.id, url: state.currentUrl, title: tab.title, mode: state.mode, readerScroll: tab.readerScroll, times: tab.times,
        readerPosition: tab.readerPosition,
        story: story ? { type: story.type, href: story.href, title: story.title, comment_url: story.comment_url, timestamp: story.timestamp, tags: story.tags, stared: story.stared, read_state: story.read_state } : null }
    }) }
  }

  private persistSoon(): void {
    if (this.restoring || this.persistTimer !== undefined) return
    this.persistTimer = setTimeout(() => this.persist(), 1000)
  }

  private persist(): void {
    clearTimeout(this.persistTimer)
    this.persistTimer = undefined
    try { this.storage?.setItem(STORAGE_KEY, JSON.stringify(this.snapshot())) } catch { /* session remains usable */ }
  }

  private publish(): void {
    if (this.restoring) return
    if (this.batching) { this.batchChanged = true; return }
    this.persist()
    this.listeners.forEach(listener => listener())
  }
}

function readTimes(value: unknown): TabTimes | undefined {
  const times = value as Partial<TabTimes> | undefined
  const keys = ["navSeq", "openedAt", "navigatedAt", "selectedAt", "activityAt"] as const
  return times && keys.every(key => Number.isSafeInteger(times[key]) && (times[key] as number) >= 0) ? times as TabTimes : undefined
}
