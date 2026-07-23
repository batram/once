import { Story } from "@once/core"
import { OnceClient } from "@once/app"
import { getOnceClient } from "./client"

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

  constructor(client: OnceClient = getOnceClient()) {
    StoryHistory.instance = this
    this.undo_history = []
    this.redo_history = []

    window.addEventListener("mouseup", (e) => {
      if (e.button.toString() == "3") {
        this.undo()
      } else if (e.button.toString() == "4") {
        this.redo()
      }
      return true
    })

    window.addEventListener(
      "keydown",
      (e) => {
        console.log("left_panel keydown", e)
        if (e.ctrlKey) {
          if (e.key == "z") {
            this.undo()
          } else if (e.key == "y") {
            this.redo()
          }
        }
        return true
      },
      true
    )

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
    console.log("history story_change", story.href, new_state, old_state)
    this.undo_history.push({ story, new_state, old_state })
    this.redo_history = []
    this.notifyStateChanged()
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
    console.log("undo")
    const hstate = this.undo_history.pop()
    if (hstate) {
      console.log("undo", hstate)
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
    console.log("redo")
    const hstate = this.redo_history.pop()
    if (hstate) {
      console.log("redo", hstate)
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
