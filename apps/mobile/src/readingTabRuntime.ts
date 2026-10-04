import { InAppBrowserSurface } from "@once/platform-mobile"
import { ReadingSession, ReaderDocumentHost, ReadingSessionState } from "@once/ui-web"
import { ReadingTabs } from "./readingTabs"
import { ReadingSurfaceCoordinator } from "./readingSurfaceCoordinator"

/** Keeps page lifetimes independent of the selected shell panel and tab. */
export class ReadingTabRuntime {
  readonly session: ReadingSession
  private panelVisible = false
  private readonly runtimes = new Map<string, { generation: string; coordinator: ReadingSurfaceCoordinator; surface: InAppBrowserSurface; reader: ReaderDocumentHost; removeTitle?: () => void }>()
  private readonly emptySession = new ReadingSession(true)
  private readonly emptyCoordinator: ReadingSurfaceCoordinator
  private selectedId: string | null = null
  private sessionListeners = new Set<(state: Readonly<ReadingSessionState>) => void>()
  private syncingTabs = false
  private usedInitialReader = false

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
      for (const [id, runtime] of this.runtimes) {
        if (runtime.reader.isReaderWindow(event.source)) this.tabs.update(id, runtime.generation, { readerScroll: event.data.y })
      }
    })
  }

  start(): void { this.tabs.subscribe(() => this.sync()) }

  get coordinator(): ReadingSurfaceCoordinator {
    return this.runtimes.get(this.selectedId ?? "")?.coordinator ?? this.emptyCoordinator
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

  setDialogOpen(open: boolean): void {
    for (const runtime of this.runtimes.values()) runtime.coordinator.setDialogOpen(open)
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
          runtime.removeTitle?.()
          runtime.coordinator.dispose()
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
          reader.setScrollPosition(tab.readerScroll)
          const coordinator = new ReadingSurfaceCoordinator(tab.session, surface, reader, this.content)
          coordinator.setDialogOpen(Boolean(document.querySelector("dialog[open]")))
          runtime = { generation: tab.generation, reader, coordinator, surface }
          this.runtimes.set(tab.id, runtime)
          coordinator.onEdgeSwipe(direction => { if (tab.id === this.tabs.activeId) this.edgeSwipe(direction) })
          void coordinator.install().then(() => {
            if (!this.tabs.tabs.includes(tab)) return
            if (tab.restored) { tab.restored = false; tab.session.retry() }
          })
          void surface.addListener("navigationFinished", event => {
            this.tabs.update(tab.id, tab.generation, { title: event.title ?? tab.session.snapshot().story?.title ?? "" })
            if (tab.id !== this.tabs.activeId) this.announce(`Background tab loaded: ${tab.title || event.url}`)
          }).then(remove => {
            const retained = this.runtimes.get(tab.id)
            if (retained?.generation === tab.generation) retained.removeTitle = remove
            else remove()
          })
        }
        runtime?.coordinator.setReadingPanelVisible(selected)
      }
      this.sessionListeners.forEach(listener => listener(this.session.snapshot()))
    } finally { this.syncingTabs = false }
  }

}
