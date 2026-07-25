import { Story } from "@once/core"

export type ReadingMode = "reader" | "browser" | "comments"
export type ReadingLoadState = "idle" | "loading" | "ready" | "error"

export interface ReadingSessionState {
  story: Story | null
  mode: ReadingMode
  currentUrl: string
  visibleStoryIndex: number
  loadState: ReadingLoadState
  navigationId: number
  canGoBack: boolean
  error: string | null
}

export type ReadingSessionListener = (state: Readonly<ReadingSessionState>) => void
export const READING_REQUEST = "once-reading-request"

export class ReadingRequestEvent extends Event {
  constructor(
    readonly story: Story,
    readonly mode: ReadingMode
  ) {
    super(READING_REQUEST, { bubbles: true, cancelable: true })
  }
}

/** Returns true when the mobile Reading host accepted the request. */
export function requestReading(story: Story, mode: ReadingMode): boolean {
  if (document.body.dataset.platform !== "mobile") return false
  return !document.body.dispatchEvent(new ReadingRequestEvent(story, mode))
}

/**
 * Shared Reading-tab state. UI entry points call the same transitions and
 * native navigation events are rejected when they belong to an older load.
 */
export class ReadingSession {
  private visibleStories: Story[] = []
  private listeners = new Set<ReadingSessionListener>()
  private state: ReadingSessionState = {
    story: null,
    mode: "browser",
    currentUrl: "",
    visibleStoryIndex: -1,
    loadState: "idle",
    navigationId: 0,
    canGoBack: false,
    error: null
  }

  snapshot(): Readonly<ReadingSessionState> {
    return { ...this.state }
  }

  subscribe(listener: ReadingSessionListener): () => void {
    this.listeners.add(listener)
    listener(this.snapshot())
    return () => this.listeners.delete(listener)
  }

  setVisibleStories(stories: Story[]): void {
    this.visibleStories = [...stories]
    this.reconcileActiveStory()
  }

  open(story: Story, mode: ReadingMode): void {
    const currentUrl = mode === "comments"
      ? story.comment_url || story.href
      : story.href
    this.state = {
      story,
      mode,
      currentUrl,
      visibleStoryIndex: this.indexOf(story),
      loadState: mode === "reader" ? "ready" : "loading",
      navigationId: this.state.navigationId,
      canGoBack: false,
      error: null
    }
    this.publish()
  }

  setMode(mode: ReadingMode): void {
    const story = this.state.story
    if (!story) return
    this.open(story, mode)
  }

  move(delta: -1 | 1): Story | null {
    if (this.visibleStories.length === 0) return null
    const current = this.state.visibleStoryIndex
    const next = current + delta
    if (next < 0 || next >= this.visibleStories.length) return null
    const story = this.visibleStories[next]
    this.open(story, this.state.mode)
    return story
  }

  navigationStarted(navigationId: number, url: string): void {
    if (navigationId < this.state.navigationId) return
    this.patch({
      navigationId,
      currentUrl: url,
      loadState: "loading",
      error: null
    })
  }

  navigationCommitted(
    navigationId: number,
    url: string,
    canGoBack = this.state.canGoBack
  ): void {
    if (navigationId < this.state.navigationId) return
    this.patch({ navigationId, currentUrl: url, canGoBack })
  }

  navigationFinished(navigationId: number, url: string): void {
    if (navigationId < this.state.navigationId) return
    this.patch({
      navigationId,
      currentUrl: url,
      loadState: "ready",
      error: null
    })
  }

  navigationFailed(navigationId: number, url: string, message: string): void {
    if (navigationId < this.state.navigationId) return
    this.patch({
      navigationId,
      currentUrl: url,
      loadState: "error",
      error: message
    })
  }

  historyChanged(navigationId: number, url: string, canGoBack: boolean): void {
    if (navigationId < this.state.navigationId) return
    this.patch({ navigationId, currentUrl: url, canGoBack })
  }

  close(): void {
    this.state = {
      ...this.state,
      story: null,
      currentUrl: "",
      visibleStoryIndex: -1,
      loadState: "idle",
      canGoBack: false,
      error: null
    }
    this.publish()
  }

  private indexOf(story: Story): number {
    return this.visibleStories.findIndex((candidate) => candidate.href === story.href)
  }

  private reconcileActiveStory(): void {
    const active = this.state.story
    if (!active) return
    const index = this.indexOf(active)
    if (index < 0) {
      this.close()
      return
    }
    this.patch({
      story: this.visibleStories[index],
      visibleStoryIndex: index
    })
  }

  private patch(value: Partial<ReadingSessionState>): void {
    this.state = { ...this.state, ...value }
    this.publish()
  }

  private publish(): void {
    const snapshot = this.snapshot()
    this.listeners.forEach((listener) => listener(snapshot))
  }
}
