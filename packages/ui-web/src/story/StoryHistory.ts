import { Story } from "@once/core"
import { OnceClient } from "@once/app"
import { getOnceClient } from "../client"

export type ReadState = "unread" | "read" | "skipped"

export interface StoryChange {
  story: Story
  new_state: ReadState
  old_state: ReadState
}

function settingsOpen(): boolean {
  return document.querySelector("#left_panel")?.getAttribute("active_panel") === "settings"
}

export class StoryHistory {
  undo_history: StoryChange[]
  redo_history: StoryChange[]
  static instance: StoryHistory
  private stateListeners = new Set<() => void>()

  constructor(client: OnceClient = getOnceClient()) {
    StoryHistory.instance = this
    this.undo_history = []
    this.redo_history = []

    // The shell owns these buttons. Suppress Chromium's document navigation
    // across the whole gesture, including auxclick after Back leaves Settings.
    for (const type of ["mousedown", "auxclick"] as const) {
      window.addEventListener(type, (event) => {
        if (event.button === 3 || event.button === 4) event.preventDefault()
      })
    }
    window.addEventListener("mouseup", (e) => {
      if (e.button !== 3 && e.button !== 4) return
      const navigation = new CustomEvent("once-settings-navigate", {
        cancelable: true,
        detail: { direction: e.button === 3 ? "back" : "forward" }
      })
      document.dispatchEvent(navigation)
      if (navigation.defaultPrevented || settingsOpen()) {
        e.preventDefault()
        return
      }
      if (e.button === 3) {
        this.undo()
      } else {
        this.redo()
      }
      return true
    })

    // Ctrl+Z / Ctrl+Y arrive through the keyboard dispatcher; see
    // keyboard/commands.ts.
    client.subscribe("historyCommand", ({ action }) => {
      if (action === "undo") {
        this.undo()
      } else {
        this.redo()
      }
    })
  }
  story_change(
    story: Story,
    new_state: "unread" | "read" | "skipped",
    old_state: "unread" | "read" | "skipped"
  ): void {
    this.undo_history.push({ story, new_state, old_state })
    this.redo_history = []
    this.notifyStateChanged()
  }

  get canUndo(): boolean {
    return this.undo_history.length > 0
  }

  /** The change a plain undo() would reverse. */
  get latestChange(): StoryChange | undefined {
    return this.undo_history.at(-1)
  }

  get canRedo(): boolean {
    return this.redo_history.length > 0
  }

  onStateChanged(listener: () => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  undo(): void {
    const latest = this.undo_history.at(-1)
    if (latest) this.undoChange(latest)
  }

  /**
   * The changes that can be reversed on their own, newest first: only the
   * latest change per story. Reversing an earlier one while a later change to
   * the same row stands would restore a state that the later change already
   * replaced, so earlier entries surface once the later one is undone.
   */
  undoableChanges(): StoryChange[] {
    const seen = new Set<string>()
    const changes: StoryChange[] = []
    for (let index = this.undo_history.length - 1; index >= 0; index--) {
      const change = this.undo_history[index]
      if (seen.has(change.story.href)) continue
      seen.add(change.story.href)
      changes.push(change)
    }
    return changes
  }

  /** Reverses one recorded change, wherever it sits in the history. */
  undoChange(change: StoryChange): void {
    if (settingsOpen()) return
    const index = this.undo_history.lastIndexOf(change)
    if (index === -1) return
    this.undo_history.splice(index, 1)
    getOnceClient().persistStoryChange(
      change.story.href,
      "read_state",
      change.old_state
    )

    this.redo_history.push({
      story: change.story,
      new_state: change.old_state,
      old_state: change.new_state
    })
    this.notifyStateChanged()
  }

  redo(): void {
    if (settingsOpen()) return
    const hstate = this.redo_history.pop()
    if (hstate) {
      getOnceClient().persistStoryChange(
        hstate.story.href,
        "read_state",
        hstate.old_state
      )

      this.undo_history.push({
        story: hstate.story,
        new_state: hstate.old_state,
        old_state: hstate.new_state
      })
      this.notifyStateChanged()
    }
  }

  private notifyStateChanged(): void {
    this.stateListeners.forEach((listener) => listener())
  }
}
