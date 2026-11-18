/**
 * Drops a selection nobody can see.
 *
 * When a focused text field is removed (the inline filter editor, a dialog's
 * input), Chromium moves the frame's selection to where the field was. The
 * shell is `user-select: none`, so nothing there can hold a caret: the
 * selection reads as "None", draws nothing, fires no `selectionchange`, and
 * stays until something else takes it. From then on every style change makes
 * Chromium look for a caret position again, a scan forward through the whole
 * document (1.2 ms with 190 stories listed), on each frame of a story drag or
 * a hover highlight.
 *
 * A selection that reads "None" has nothing to lose, so clearing it is always
 * safe. That is done once the event that may have removed a field has run its
 * course, which is why this waits a task: the removal happens in handlers
 * that run after this one.
 */
export function initStaleSelectionSweep(): void {
  let queued = false
  const sweep = () => {
    queued = false
    const selection = document.getSelection()
    if (selection?.type === "None") selection.removeAllRanges()
  }
  const queue = () => {
    if (queued) return
    queued = true
    setTimeout(sweep, 0)
  }
  for (const type of ["click", "keyup", "pointerup"]) {
    document.addEventListener(type, queue, { capture: true, passive: true })
  }
}
