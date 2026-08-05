import { StoryCursor } from "../story/storyCursor"
import { StoryHistory } from "../story/StoryHistory"
import { toggledStoryUrl } from "../story/selectedStoryToggle"
import { getOnceClient } from "../client"
import { isSourcePickerOpen } from "../picker/sourcePicker"
import { isStoryAnchoredMenuOpen } from "../menu/storyAnchoredMenu"
import { initPaneFocus } from "../shell/paneFocus"
import { registerStoryActionHandlers } from "./storyActionCommands"
import { getKeyboardDispatcher } from "./index"

/** Installs the shell-wide keyboard commands and the story cursor. */
export function mountKeyboard(history: StoryHistory): StoryCursor {
  initPaneFocus()
  const keyboard = getKeyboardDispatcher()
  // The dispatcher listens in the capture phase, so it runs before the
  // document-level handlers these overlays install; it must stand down while
  // one of them owns the keyboard.
  keyboard.registerBlocker(isStoryAnchoredMenuOpen)
  keyboard.registerBlocker(isSourcePickerOpen)
  keyboard.register("history.undo", () => history.undo())
  keyboard.register("history.redo", () => history.redo())

  const cursor = new StoryCursor()
  cursor.mount()
  keyboard.register("story.cursor-next", () => cursor.moveBy(1))
  keyboard.register("story.cursor-prev", () => cursor.moveBy(-1))
  keyboard.register("story.action-left", () => cursor.runSwipeAction(-1))
  keyboard.register("story.action-right", () => cursor.runSwipeAction(1))
  keyboard.register("story.open", () => cursor.run((row) => row.openStory("_self")))
  keyboard.register("story.open-comments", () => cursor.run((row) => row.openComments()))
  // Follows the open page rather than the cursor, and replaces it rather than
  // opening a tab: this is one story seen two ways, not two things to read.
  //
  // Navigates directly instead of going through openStoryUrl, which marks the
  // URL it is given as read — that key is a story href, and half the time this
  // hands it a comments URL. The story was marked read when it was opened; a
  // switch between its two faces is not a second reading.
  keyboard.register("story.toggle-comments", () => {
    const url = toggledStoryUrl()
    if (url) getOnceClient().openUrl(url, "current")
  })
  // Everything the story context menu can do is bindable too, unbound until
  // the user picks a key. See storyActionCommands.ts.
  registerStoryActionHandlers(cursor, (id, handler) => keyboard.register(id, handler))
  keyboard.mount()
  return cursor
}
