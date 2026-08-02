import { Story } from "@once/core"
import { ReadState, StoryHistory } from "./StoryHistory"
import { SwipeConfig } from "./swipe/geometry"

/**
 * Transient "Skipped … / Undo" bar for touch platforms.
 *
 * Desktop reaches undo through Ctrl+Z, the mouse back button and the context
 * menu; none of those exist on a phone, and the system back gesture is already
 * a six-level dismissal chain that ends in exitApp — putting a data mutation on
 * it would make "back to leave the app" ambiguous. So the affordance comes to
 * the user instead: the row that just moved announces itself, and the offer
 * expires.
 *
 * Consecutive changes coalesce into one bar rather than queueing, because the
 * mis-swipe this exists for usually happens in a run. The bar then undoes the
 * whole run, which is what "that wasn't what I meant" means in that moment.
 */
export class UndoSnackbar {
  private static instance?: UndoSnackbar
  private readonly root: HTMLElement
  private readonly message: HTMLElement
  private readonly action: HTMLButtonElement
  private progress?: HTMLElement
  private hideTimer?: ReturnType<typeof setTimeout>
  /** Changes the bar currently offers to reverse. */
  private pending = 0
  /**
   * Counted separately from `pending` because the two differ whenever a run
   * touches one row twice: the label is about stories, the undo is about
   * changes, and reporting either number as the other would be a lie.
   */
  private readonly pendingStories = new Set<string>()

  private constructor(history: StoryHistory) {
    this.root = document.createElement("div")
    this.root.classList.add("undo_snackbar")
    this.root.dataset.testid = "undo-snackbar"
    // polite: a skip is the user's own action, so the announcement must not
    // interrupt whatever they are already reading.
    this.root.setAttribute("role", "status")
    this.root.hidden = true

    this.message = document.createElement("p")
    this.message.classList.add("undo_snackbar_message")

    this.action = document.createElement("button")
    this.action.type = "button"
    this.action.classList.add("button", "undo_snackbar_action")
    this.action.dataset.testid = "undo-snackbar-action"
    this.action.textContent = "Undo"
    this.action.addEventListener("click", () => this.undoPending(history))

    this.root.append(this.message, this.action)
    document.body.append(this.root)

    history.onChangeRecorded((story, newState) => {
      this.show(story, newState)
    })
  }

  static mount(history = StoryHistory.instance): UndoSnackbar | undefined {
    if (!history) return undefined
    UndoSnackbar.instance ??= new UndoSnackbar(history)
    return UndoSnackbar.instance
  }

  private show(story: Story, newState: ReadState): void {
    if (!SwipeConfig.current.undoSnackbarEnabled) {
      this.dismiss()
      return
    }
    this.pending += 1
    this.pendingStories.add(story.href)
    const stories = this.pendingStories.size
    this.message.textContent =
      this.pending === 1
        ? describeChange(story, newState)
        : `${stories} ${stories === 1 ? "story" : "stories"} updated`
    this.root.hidden = false
    this.restartCountdown()
  }

  /**
   * The countdown reads as a promise that the offer is still open, so it has to
   * start over whenever the offer widens. Replacing the element rather than
   * resetting the animation avoids a mid-flight restart that CSS alone cannot
   * express without a forced reflow.
   */
  private restartCountdown(): void {
    const duration = SwipeConfig.current.undoSnackbarDurationMs
    clearTimeout(this.hideTimer)
    this.progress?.remove()
    this.progress = document.createElement("div")
    this.progress.classList.add("undo_snackbar_progress")
    this.progress.setAttribute("aria-hidden", "true")
    this.progress.style.setProperty(
      "--undo-snackbar-duration",
      `${duration}ms`
    )
    this.root.append(this.progress)
    this.hideTimer = setTimeout(() => this.dismiss(), duration)
  }

  private undoPending(history: StoryHistory): void {
    // Snapshot first: undo() notifies listeners, and dismissing mid-loop would
    // otherwise clear the counter the loop is still reading.
    const count = this.pending
    this.dismiss()
    for (let index = 0; index < count; index++) history.undo()
  }

  private dismiss(): void {
    clearTimeout(this.hideTimer)
    this.hideTimer = undefined
    this.progress?.remove()
    this.progress = undefined
    this.pending = 0
    this.pendingStories.clear()
    this.root.hidden = true
  }
}

function describeChange(story: Story, newState: ReadState): string {
  const title = story.title || story.href
  switch (newState) {
    case "skipped":
      return `Skipped “${title}”`
    case "read":
      return `Marked read “${title}”`
    case "unread":
      return `Marked unread “${title}”`
  }
}
