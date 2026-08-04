import { StoryCursor } from "../story/storyCursor"
import { StoryHistory } from "../story/StoryHistory"
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
  // Everything the story context menu can do is bindable too, unbound until
  // the user picks a key. See storyActionCommands.ts.
  registerStoryActionHandlers(cursor, (id, handler) => keyboard.register(id, handler))
  keyboard.mount()
  return cursor
}
