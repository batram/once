import { Story } from "@once/core"
import { OnceClient } from "@once/app"
import { getOnceClient } from "../client"

export type ReadState = "unread" | "read" | "skipped"

function settingsOpen(): boolean {
  return document.querySelector("#left_panel")?.getAttribute("active_panel") === "settings"
}

export class StoryHistory {
  undo_history: {
    story: Story
    new_state: "unread" | "read" | "skipped"
    old_state: "unread" | "read" | "skipped"
  }[]
  redo_history: {
    story: Story
    new_state: "unread" | "read" | "skipped"
    old_state: "unread" | "read" | "skipped"
  }[]
  static instance: StoryHistory
  private stateListeners = new Set<() => void>()
  private changeListeners = new Set<(story: Story, newState: ReadState) => void>()

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
    this.changeListeners.forEach((listener) => listener(story, new_state))
  }

  /**
   * Fires only when a user action records a new undoable change — undo and redo
   * move the same stack without notifying here, so a listener can offer to
   * reverse a change without re-arming itself on the reversal.
   */
  onChangeRecorded(
    listener: (story: Story, newState: ReadState) => void
  ): () => void {
    this.changeListeners.add(listener)
    return () => this.changeListeners.delete(listener)
  }

  get canUndo(): boolean {
    return this.undo_history.length > 0
  }

  get canRedo(): boolean {
    return this.redo_history.length > 0
  }

  onStateChanged(listener: () => void): () => void {
    this.stateListeners.add(listener)
    return () => this.stateListeners.delete(listener)
  }

  undo(): void {
    if (settingsOpen()) return
    const hstate = this.undo_history.pop()
    if (hstate) {
      getOnceClient().persistStoryChange(
        hstate.story.href,
        "read_state",
        hstate.old_state
      )

      this.redo_history.push({
        story: hstate.story,
        new_state: hstate.old_state,
        old_state: hstate.new_state
      })
      this.notifyStateChanged()
    }
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
