const STORY_EXIT_TRANSITION_FALLBACK_MS = 750

/**
 * Finish a story's slide-out even if its transition is cancelled when a
 * native/webview reading surface takes focus. A missing transitionend used to
 * leave the translated row in flow as a blank, full-height slot.
 */
export function finishStoryExitTransition(
  element: HTMLElement,
  complete: () => void,
  fallbackMs = STORY_EXIT_TRANSITION_FALLBACK_MS
): () => void {
  let finished = false

  const cleanup = () => {
    element.removeEventListener("transitionend", onTransition)
    element.removeEventListener("transitioncancel", onTransition)
    clearTimeout(fallback)
  }
  const finish = () => {
    if (finished) return
    finished = true
    cleanup()
    complete()
  }
  const onTransition = (event: TransitionEvent) => {
    if (event.target !== element || event.propertyName !== "margin-left") return
    finish()
  }
  const fallback = setTimeout(finish, fallbackMs)

  element.addEventListener("transitionend", onTransition)
  element.addEventListener("transitioncancel", onTransition)

  return () => {
    if (finished) return
    finished = true
    cleanup()
  }
}
