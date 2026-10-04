import { Story } from "@once/core"
import { ReadingSession } from "@once/ui-web"
import type { ReadingSessionState } from "@once/ui-web"
type ReadingMode = ReadingSessionState["mode"]

const STORAGE_KEY = "once:mobile-reading-tabs:v1"
interface SavedTab {
  id: string
  url: string
  title: string
  mode: ReadingMode
  story: Record<string, unknown> | null
  readerScroll: number
}
export interface ReadingTab {
  readonly id: string
  readonly generation: string
  readonly session: ReadingSession
  title: string
  readerScroll: number
  restored: boolean
  preview?: string
}
interface Snapshot { version: 1; activeId: string | null; tabs: SavedTab[] }

/** Owns metadata independently of feed membership and native runtime lifetime. */
export class ReadingTabs {
  private entries: ReadingTab[] = []
  private active: string | null = null
  private listeners = new Set<() => void>()
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
    if (select) this.active = tab.id
    this.publish()
    return tab
  }

  select(id: string): void {
    if (!this.entries.some(tab => tab.id === id)) return
    this.active = id
    this.publish()
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

  update(id: string, generation: string, value: { title?: string; readerScroll?: number }): void {
    const tab = this.entries.find(entry => entry.id === id && entry.generation === generation)
    if (!tab) return
    if (value.readerScroll !== undefined && Number.isFinite(value.readerScroll)) tab.readerScroll = Math.max(0, value.readerScroll)
    // Reader scroll reports arrive continuously and nothing renders them.
    if (value.title === undefined) { this.persistSoon(); return }
    tab.title = value.title
    this.publish()
  }

  private make(id: string, generation: string = crypto.randomUUID()): ReadingTab {
    const tab: ReadingTab = { id, generation, session: new ReadingSession(true), title: "", readerScroll: 0, restored: false }
    let initial = true
    let previousUrl = ""
    let previousNavigation = 0
    this.removers.set(id, tab.session.subscribe(state => {
      // Only a new document resets; same-document history (pushState) keeps it.
      const newDocument = !state.currentUrl || state.loadState === "loading" || state.navigationId !== previousNavigation
      if (state.currentUrl !== previousUrl && newDocument) {
        tab.title = ""
        tab.preview = undefined
        tab.readerScroll = 0
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
      validated.push({ ...tab, readerScroll: Number.isFinite(tab.readerScroll) ? Math.max(0, tab.readerScroll) : 0 })
    }
    this.entries = validated.map(tab => this.fromSaved(tab))
    this.active = value.activeId === null || ids.has(value.activeId ?? "") ? value.activeId : this.entries[0]?.id ?? null
  }

  private snapshot(): Snapshot {
    return { version: 1, activeId: this.active, tabs: this.entries.map(tab => {
      const state = tab.session.snapshot()
      const story = state.story
      return { id: tab.id, url: state.currentUrl, title: tab.title, mode: state.mode, readerScroll: tab.readerScroll,
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
