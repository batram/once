/**
 * Decides whether reader speech may scroll the page to the segment it is
 * reading. Once the user scrolls on their own, speech stops pulling the page
 * back; it follows again once the segment being read is on screen or the
 * user asks for a position (a segment tap, play, previous, next).
 */
export interface ReaderTtsFollow {
  /** Brings the newly read element into view unless the user scrolled away. */
  reveal(element: HTMLElement): void
  /** The user chose a reading position; follow it again. */
  resume(): void
  dispose(): void
}

const SCROLL_KEYS = new Set([
  "ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "
])

const TOP_MARGIN = 64
const BOTTOM_MARGIN = 24

export function createReaderTtsFollow(view: Window = window): ReaderTtsFollow {
  let detached = false
  const detach = (): void => { detached = true }
  const onKey = (event: KeyboardEvent): void => {
    if (!SCROLL_KEYS.has(event.key) || isInteractive(event.target)) return
    detach()
  }
  // A press on the root element is a press on the page's own scrollbar.
  const onPointer = (event: PointerEvent): void => {
    if (event.target === view.document.documentElement) detach()
  }
  const passive = { passive: true, capture: true }
  view.addEventListener("wheel", detach, passive)
  view.addEventListener("touchmove", detach, passive)
  view.addEventListener("keydown", onKey, true)
  view.addEventListener("pointerdown", onPointer, true)

  return {
    reveal(element) {
      const bounds = element.getBoundingClientRect()
      if (detached) {
        // Reading reached what the user is looking at: follow from here on.
        if (bounds.bottom > 0 && bounds.top < view.innerHeight) detached = false
        return
      }
      if (bounds.top < TOP_MARGIN || bounds.bottom > view.innerHeight - BOTTOM_MARGIN) {
        element.scrollIntoView({ behavior: "smooth", block: "center" })
      }
    },
    resume() { detached = false },
    dispose() {
      view.removeEventListener("wheel", detach, passive)
      view.removeEventListener("touchmove", detach, passive)
      view.removeEventListener("keydown", onKey, true)
      view.removeEventListener("pointerdown", onPointer, true)
    }
  }
}

function isInteractive(target: EventTarget | null): boolean {
  if (!target || typeof (target as Element).closest !== "function") return false
  return Boolean((target as Element).closest(
    "input, select, textarea, button, [contenteditable]:not([contenteditable='false'])"
  ))
}
