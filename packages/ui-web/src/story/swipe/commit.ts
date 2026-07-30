import { SwipeActionId } from "@once/app"
import { getOnceClient } from "../../client"
import { executeStoryMenuAction } from "../../menu/storyContextMenu"
import { StoryHistory } from "../StoryHistory"
import type { StoryListItem } from "../StoryListItem"

/**
 * Runs what a released swipe selected.
 *
 * Most actions already exist as menu actions; routing through them keeps
 * reader persistence and the filter dialog in one place rather than growing a
 * second implementation behind the gesture.
 */
export function commitSwipeAction(
  row: StoryListItem,
  action: SwipeActionId
): void {
  switch (action) {
    case "none":
      return
    case "open":
      row.read_btn.classList.add("user_interaction")
      row.openStory("_self")
      return
    case "open-browser":
      void executeStoryMenuAction("open-browser", row)
      return
    case "skip":
      // Unconditional, unlike toggle-read: a swipe to skip should skip.
      row.read_btn.classList.add("user_interaction")
      StoryHistory.instance.story_change(
        row.story,
        "skipped",
        row.story.read_state
      )
      void getOnceClient().persistStoryChange(
        row.story.href,
        "read_state",
        "skipped"
      )
      return
    case "open-reader":
      void executeStoryMenuAction("open-reader", row)
      return
    case "toggle-read":
      void executeStoryMenuAction("toggle-read", row)
      return
    case "toggle-bookmark":
      void executeStoryMenuAction("toggle-bookmark", row)
      return
    case "filter":
      void executeStoryMenuAction("filter", row)
  }
}
