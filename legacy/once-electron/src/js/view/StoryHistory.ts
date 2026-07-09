import { Story } from "../data/Story"
import { StoryMap } from "../data/StoryMap"

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

  constructor() {
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
  }
  story_change(
    story: Story,
    new_state: "unread" | "read" | "skipped",
    old_state: "unread" | "read" | "skipped"
  ): void {
    console.log("history story_change", story.href, new_state, old_state)
    this.undo_history.push({ story, new_state, old_state })
  }

  undo(): void {
    console.log("undo")
    if (this.undo_history.length > 0) {
      const hstate = this.undo_history.pop()
      console.log("undo", hstate)
      StoryMap.remote.persist_story_change(
        hstate.story.href,
        "read_state",
        hstate.old_state
      )

      this.redo_history.push({
        story: hstate.story,
        new_state: hstate.old_state,
        old_state: hstate.new_state,
      })
    }
  }

  redo(): void {
    console.log("redo")
    if (this.redo_history.length > 0) {
      const hstate = this.redo_history.pop()
      console.log("redo", hstate)
      StoryMap.remote.persist_story_change(
        hstate.story.href,
        "read_state",
        hstate.old_state
      )

      this.undo_history.push({
        story: hstate.story,
        new_state: hstate.old_state,
        old_state: hstate.new_state,
      })
    }
  }
}
