/**
 * A sample story row inside the swipe settings block.
 *
 * The numbers in the settings are hard to picture — 200px of travel means
 * nothing until a thumb has covered it. This row is the real StoryListItem
 * gesture driven by the values currently *in the form*, so an edit can be
 * tried before it is saved, and a release reports the action it would have run
 * instead of running it against a made-up story.
 */

import { SWIPE_ACTION_LABELS, SwipeActionId, SwipeSettings } from "@once/app"
import { Story } from "@once/core"
import {
  createSwipeGeometry,
  StoryListItem,
  SwipeStage
} from "./StoryListItem"
import {
  beginTouchGesture,
  endTouchGesture,
  updateTouchGesture
} from "./TouchGestureLock"

const PREVIEW_STORY_HREF = "https://example.com/swipe-preview"

/**
 * Type "EX" so the badge reads like a collector's own ([HN], [LO], …) without
 * impersonating one; no collector emits it, so settings.css colours it.
 */
function previewStory(): Story {
  const story = new Story(
    "EX",
    PREVIEW_STORY_HREF,
    "Try the gesture — drag this row either way",
    `${PREVIEW_STORY_HREF}#comments`,
    Date.now() - 36 * 60 * 1000
  )
  story.tags = [{ class: "tag", text: "example" }]
  return story
}

/**
 * Nothing on this row may touch stored state, so every link and button on it
 * is neutralised at the capture phase rather than trusted to be inert.
 */
function blockInteractions(
  row: StoryListItem,
  report: (text: string) => void
): void {
  for (const type of ["click", "auxclick", "mousedown", "mouseup"]) {
    row.addEventListener(
      type,
      (event) => {
        const target = event.target as Element | null
        if (!target?.closest("a, .btn, .menu_btn")) return
        event.preventDefault()
        event.stopPropagation()
        if (event.type === "click") {
          report("Sample row — its links and buttons do nothing.")
        }
      },
      true
    )
  }
}

function describe(action: SwipeActionId, stage: SwipeStage): string {
  if (stage === 0) return "Released below stage 1 — nothing would run."
  if (action === "none") {
    return `Stage ${stage} — set to “Nothing”, so nothing would run.`
  }
  return `Stage ${stage} → ${SWIPE_ACTION_LABELS[action]}`
}

/**
 * @param host empty container inside the swipe settings block
 * @param readSettings the settings as currently edited, already normalized
 */
export function installSwipePreview(
  host: HTMLElement,
  readSettings: () => SwipeSettings
): void {
  host.textContent = ""

  // The reveal behind the row is positioned against its nearest positioned
  // ancestor — #stories in the app, this element here.
  const stage = document.createElement("div")
  stage.classList.add("swipe_preview_stage")
  host.append(stage)

  const status = document.createElement("p")
  status.classList.add("swipe_preview_status")
  status.dataset.testid = "swipe-preview-status"
  const report = (text: string): void => {
    status.textContent = text
  }
  report("Drag the row to feel the detents; nothing is saved or opened.")

  const row = new StoryListItem(previewStory())
  row.dataset.testid = "swipe-preview-row"
  row.dataset.swipePreview = "true"
  row.swipePreview = {
    geometry: createSwipeGeometry(readSettings),
    scroller: stage,
    onAction: (action, stageNumber) => report(describe(action, stageNumber))
  }
  blockInteractions(row, report)
  stage.append(row)
  host.append(status)

  // The row's touch path only runs once the gesture is locked horizontal, a
  // lock the story list drives from attachPullToRefresh. There is no pull to
  // refresh here, so the preview keeps the lock for its own stage element.
  stage.addEventListener("touchstart", (event) => {
    const touch = event.touches[0]
    if (touch) beginTouchGesture(stage, touch.clientX, touch.clientY)
  }, { passive: true })
  stage.addEventListener("touchmove", (event) => {
    const touch = event.touches[0]
    if (touch) updateTouchGesture(stage, touch.clientX, touch.clientY)
  }, { passive: true })
  for (const type of ["touchend", "touchcancel"]) {
    stage.addEventListener(type, () => endTouchGesture(stage))
  }
}
