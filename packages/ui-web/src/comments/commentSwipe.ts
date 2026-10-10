// Touch: a horizontal swipe on a comment selects it and acts like the arrow
// keys. Swipe left closes (collapses), swipe right opens (expands). The
// comment follows the finger a little and snaps back on release. Thresholds
// are the Hacker News navigator userscript's, which feel right on a phone.

const SWIPE_MIN_PX = 50
/** Slower than this is a drag, not a swipe. */
const SWIPE_MAX_MS = 600
/** How far the comment follows the finger, in px. */
const SWIPE_SHIFT_MAX = 40
/** Movement before deciding the gesture is horizontal. */
const SLOP_PX = 10
/** Touches this close to a screen edge belong to the shell's back/forward swipe. */
const EDGE_PX = 24

export interface CommentSwipeTarget {
  /** The comment index a touch landed on, or -1. */
  indexOf(target: EventTarget | null): number
  swipe(index: number, direction: -1 | 1): void
}

interface Touching {
  index: number
  main: HTMLElement
  x: number
  y: number
  time: number
  moved: boolean
}

const isHorizontal = (dx: number, dy: number) => Math.abs(dx) >= Math.abs(dy) * 2

/** One delegated set of listeners on the thread, however many comments it has. */
export function attachCommentSwipe(root: HTMLElement, target: CommentSwipeTarget): () => void {
  let touching: Touching | null = null

  const shift = (main: HTMLElement, px: number | null) => {
    main.classList.toggle("is-swiping", px !== null)
    if (px === null) main.style.removeProperty("--comment-swipe-shift")
    else main.style.setProperty("--comment-swipe-shift", `${px}px`)
  }

  const start = (event: TouchEvent) => {
    touching = null
    if (event.touches.length !== 1) return
    const touch = event.touches[0]
    if (touch.clientX < EDGE_PX || touch.clientX > window.innerWidth - EDGE_PX) return
    const index = target.indexOf(event.target)
    // The innermost comment's own text and header, not the replies around it.
    const main = (event.target as Element | null)?.closest?.(".comment_main")
    if (index < 0 || !(main instanceof HTMLElement)) return
    touching = { index, main, x: touch.clientX, y: touch.clientY, time: Date.now(), moved: false }
  }

  const move = (event: TouchEvent) => {
    if (!touching || event.touches.length !== 1) return
    const touch = event.touches[0]
    const dx = touch.clientX - touching.x
    const dy = touch.clientY - touching.y
    // Only start following once the gesture is clearly horizontal.
    if (!touching.moved && (Math.abs(dx) < SLOP_PX || !isHorizontal(dx, dy))) return
    touching.moved = true
    // Eased, so it feels like resistance and never runs off the screen.
    shift(touching.main, Math.sign(dx) * Math.min(Math.abs(dx) / 2, SWIPE_SHIFT_MAX))
  }

  const finish = (event: TouchEvent) => {
    const done = touching
    touching = null
    if (!done) return
    if (done.moved) shift(done.main, null)
    if (event.type !== "touchend" || event.changedTouches.length !== 1) return
    const touch = event.changedTouches[0]
    const dx = touch.clientX - done.x
    const dy = touch.clientY - done.y
    if (Date.now() - done.time > SWIPE_MAX_MS) return
    if (Math.abs(dx) < SWIPE_MIN_PX || !isHorizontal(dx, dy)) return
    target.swipe(done.index, dx < 0 ? -1 : 1)
  }

  root.addEventListener("touchstart", start, { passive: true })
  root.addEventListener("touchmove", move, { passive: true })
  root.addEventListener("touchend", finish, { passive: true })
  root.addEventListener("touchcancel", finish, { passive: true })
  return () => {
    root.removeEventListener("touchstart", start)
    root.removeEventListener("touchmove", move)
    root.removeEventListener("touchend", finish)
    root.removeEventListener("touchcancel", finish)
  }
}
