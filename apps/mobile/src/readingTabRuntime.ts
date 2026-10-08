import { InAppBrowserSurface } from "@once/platform-mobile"
import { readReaderPosition } from "@once/core"
import { ReadingSession, ReaderDocumentHost, ReadingSessionState } from "@once/ui-web"
import { ReadingTabs, type ReadingTab } from "./readingTabs"
import { ReadingSurfaceCoordinator } from "./readingSurfaceCoordinator"

type Cover = "menu" | "overlay" | "dialog" | "extensionPage"

/** Keeps page lifetimes independent of the selected shell panel and tab. */
export class ReadingTabRuntime {
  readonly session: ReadingSession
  private panelVisible = false
  private readonly runtimes = new Map<string, { generation: string; coordinator: ReadingSurfaceCoordinator; surface: InAppBrowserSurface; reader: ReaderDocumentHost }>()
  private readonly emptySession = new ReadingSession(true)
  private readonly emptyCoordinator: ReadingSurfaceCoordinator
  private selectedId: string | null = null
  private sessionListeners = new Set<(state: Readonly<ReadingSessionState>) => void>()
  private syncingTabs = false
  private usedInitialReader = false
  // Shell UI covering the panel; a tab created or selected under it must stay hidden too.
  private readerClosedListener: ((reader: ReaderDocumentHost) => void) | null = null
  // A tab is audible while its reader speaks or its page plays media.
  private readonly audible = new Map<string, { reader: boolean; page: boolean }>()
  private readonly covers: Record<Cover, boolean> = { menu: false, overlay: false, dialog: false, extensionPage: false }

  constructor(
    readonly tabs: ReadingTabs,
    private readonly surface: InAppBrowserSurface,
    private readonly initialReader: ReaderDocumentHost,
    private readonly content: HTMLElement,
    private readonly beforeSwitch: () => void,
    private readonly edgeSwipe: (direction: "back" | "forward") => void,
    private readonly announce: (message: string) => void
  ) {
    this.emptyCoordinator = new ReadingSurfaceCoordinator(this.emptySession, surface, initialReader, content)
    initialReader.onDocumentClosed(() => this.readerClosedListener?.(initialReader))
    this.session = new Proxy(this.emptySession, {
      get: (_target, property) => {
        if (property === "subscribe") return (listener: (state: Readonly<ReadingSessionState>) => void) => {
          this.sessionListeners.add(listener)
          listener(this.session.snapshot())
          return () => this.sessionListeners.delete(listener)
        }
        const session = this.tabs.selected?.session ?? this.emptySession
        const value = Reflect.get(session, property)
        return typeof value === "function" ? value.bind(session) : value
      }
    })
    window.addEventListener("message", event => {
      if (event.data?.channel !== "once-reader-scroll" || event.data.type !== "position" || !Number.isFinite(event.data.y)) return
      const readerPosition = readReaderPosition(event.data.position) ?? undefined
      for (const [id, runtime] of this.runtimes) {
        if (runtime.reader.isReaderWindow(event.source)) this.tabs.update(id, runtime.generation, { readerScroll: event.data.y, readerPosition })
      }
    })
  }

  start(): void { this.tabs.subscribe(() => this.sync()) }

  get coordinator(): ReadingSurfaceCoordinator {
    return this.runtimes.get(this.selectedId ?? "")?.coordinator ?? this.emptyCoordinator
  }

  /** A reader document closing or being replaced, in any tab. */
  onReaderClosed(listener: (reader: ReaderDocumentHost) => void): void {
    this.readerClosedListener = listener
  }

  isReaderWindow(source: unknown): boolean {
    return this.initialReader.isReaderWindow(source) ||
      [...this.runtimes.values()].some(runtime => runtime.reader.isReaderWindow(source))
  }

  tabForReaderWindow(source: unknown): ReadingTab | undefined {
    for (const [id, runtime] of this.runtimes) {
      if (runtime.reader.isReaderWindow(source)) return this.tabs.tabs.find(tab => tab.id === id && tab.generation === runtime.generation)
    }
    return undefined
  }

  /** Reader speech is reported per frame; the tab owning that frame plays it. */
  setReaderAudible(source: unknown, audible: boolean): void {
    for (const [id, runtime] of this.runtimes) {
      if (runtime.reader.isReaderWindow(source)) this.setAudible(id, runtime.generation, "reader", audible)
    }
  }

  private setAudible(id: string, generation: string, kind: "reader" | "page", audible: boolean): void {
    const key = `${id}:${generation}`
    const state = { ...(this.audible.get(key) ?? { reader: false, page: false }), [kind]: audible }
    this.audible.set(key, state)
    this.tabs.setAudio(id, generation, state.reader || state.page)
  }

  get reader(): ReaderDocumentHost {
    return this.runtimes.get(this.selectedId ?? "")?.reader ?? this.initialReader
  }

  get pageSurface(): InAppBrowserSurface {
    return this.runtimes.get(this.selectedId ?? "")?.surface ?? this.surface
  }

  setPanelVisible(visible: boolean): void {
    this.panelVisible = visible
    this.sync()
  }

  setCovered(cover: Cover, open: boolean): void {
    this.covers[cover] = open
    for (const coordinator of [this.emptyCoordinator, ...Array.from(this.runtimes.values(), runtime => runtime.coordinator)]) {
      applyCover(coordinator, cover, open)
    }
  }

  /** A native popup tab whose page was already loading before its runtime listened. */
  adopt(id: string, url: string): void {
    this.runtimes.get(id)?.coordinator.adopt(url)
  }

  /** Runs a script in a tab's page, for tabs with a live native surface; null otherwise. */
  async evaluate(tabId: string, script: string): Promise<string | null> {
    const runtime = this.runtimes.get(tabId)
    return runtime ? runtime.surface.evaluateJavaScript(script) : null
  }

  async capturePreview(): Promise<void> {
    const tab = this.tabs.selected
    if (!tab || !this.panelVisible) return
    const state = tab.session.snapshot()
    if (!state.currentUrl || state.loadState === "error") return
    const rect = this.content.getBoundingClientRect()
    try {
      const preview = await this.pageSurface.capturePreview?.({
        reader: state.mode === "reader",
        bounds: { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
      })
      if (preview && tab.session.snapshot().navigationId === state.navigationId && tab.session.snapshot().mode === state.mode) this.tabs.setPreview(tab.id, tab.generation, state.currentUrl, preview)
    } catch { /* A missing or reclaimed surface keeps its last preview. */ }
  }

  private sync(): void {
    if (this.syncingTabs) return
    this.syncingTabs = true
    try {
      if (this.selectedId !== this.tabs.activeId) {
        this.beforeSwitch()
        this.selectedId = this.tabs.activeId
        void this.surface.selectTab?.(this.tabs.selected ? { tabId: this.tabs.selected.id, generation: this.tabs.selected.generation } : null)
      }
      for (const [id, runtime] of this.runtimes) {
        if (!this.tabs.tabs.some(tab => tab.id === id && tab.generation === runtime.generation)) {
          // The initial reader is also the fallback without a tab; keep it alive for reuse.
          this.audible.delete(`${id}:${runtime.generation}`)
          const shared = runtime.reader === this.initialReader
          runtime.coordinator.dispose(shared)
          if (shared) this.usedInitialReader = false
          this.runtimes.delete(id)
        }
      }
      for (const tab of this.tabs.tabs) {
        let runtime = this.runtimes.get(tab.id)
        const selected = tab.id === this.tabs.activeId && this.panelVisible
        if (!runtime && (!tab.restored || selected)) {
          const surface = this.surface.forTab?.({ tabId: tab.id, generation: tab.generation }) ?? this.surface
          const reader = this.usedInitialReader ? this.initialReader.createSibling() : this.initialReader
          this.usedInitialReader = true
          if (reader !== this.initialReader) reader.onDocumentClosed(() => this.readerClosedListener?.(reader))
          reader.setScrollPosition(() => tab.readerScroll)
          reader.setReaderPosition(() => tab.pendingReaderPosition)
          const coordinator = new ReadingSurfaceCoordinator(tab.session, surface, reader, this.content, undefined, tab.history)
          for (const cover of Object.keys(this.covers) as Cover[]) applyCover(coordinator, cover, this.covers[cover])
          runtime = { generation: tab.generation, reader, coordinator, surface }
          this.runtimes.set(tab.id, runtime)
          coordinator.onEdgeSwipe(direction => { if (tab.id === this.tabs.activeId) this.edgeSwipe(direction) })
          coordinator.onMediaStateChanged(playing => this.setAudible(tab.id, tab.generation, "page", playing))
          coordinator.setDesktopSite(tab.desktopSite === true)
          coordinator.onDesktopSiteChanged(enabled => this.tabs.setDesktopSite(tab.id, tab.generation, enabled))
          coordinator.onCloseRequested(() => {
            if (!this.tabs.tabs.includes(tab)) return
            this.tabs.close(tab.id)
            this.announce("The page closed its tab")
          })
          coordinator.onNavigationFinished(event => {
            this.tabs.update(tab.id, tab.generation, { title: event.title ?? tab.session.snapshot().story?.title ?? "" })
            if (tab.id !== this.tabs.activeId) this.announce(`Background tab loaded: ${tab.title || event.url}`)
          })
          void coordinator.install().then(() => {
            if (!this.tabs.tabs.includes(tab)) return
            if (tab.restored) { tab.restored = false; tab.session.retry() }
          })
        }
        runtime?.coordinator.setReadingPanelVisible(selected)
      }
      this.sessionListeners.forEach(listener => listener(this.session.snapshot()))
    } finally { this.syncingTabs = false }
  }

}

function applyCover(coordinator: ReadingSurfaceCoordinator, cover: Cover, open: boolean): void {
  if (cover === "menu") coordinator.setMenuOpen(open)
  else if (cover === "overlay") coordinator.setOverlayOpen(open)
  else if (cover === "dialog") coordinator.setDialogOpen(open)
  else coordinator.setExtensionPageOpen(open)
}
