/**
 * Story actions on touch.
 *
 * Two gestures reach the same menu at the same anchor: a tap on the row's ⋮
 * button, and a long-press anywhere else on the row. Both raise
 * StoryMenuRequestEvent from the row, and this module answers it by opening the
 * shared anchored menu, so all persistence stays in @once/ui-web.
 */

import {
  isStoryAnchoredMenuOpen,
  openStoryAnchoredMenu,
  STORY_MENU_REQUEST,
  StoryListItem,
  StoryMenuRequestEvent
} from "@once/ui-web"

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE_PX = 10
/** Marks the row while the long-press builds; drives the progress line. */
const PRESS_CLASS = "press_building"

/** The tab bar is fixed to the bottom; the menu must never hide behind it. */
function tabBarHeight(): number {
  const menu = document.querySelector<HTMLElement>("#menu")
  if (!menu) return 0
  return Math.round(menu.getBoundingClientRect().height)
}

function buildChannel(): "release" | "dev" {
  return document.body.dataset.buildChannel === "dev" ? "dev" : "release"
}

export function installStoryMenu(): void {
  document.addEventListener(STORY_MENU_REQUEST, (event) => {
    const request = event as StoryMenuRequestEvent
    openStoryAnchoredMenu({
      anchor: request.anchor,
      bottomInset: tabBarHeight(),
      context: {
        platform: "mobile",
        buildChannel: buildChannel(),
        story: request.story
      }
    })
  })

  installLongPress()

  // Android fires contextmenu on long-press; the anchored menu replaces it.
  document.addEventListener("contextmenu", (event) => {
    if ((event.target as Element | null)?.closest("story-item")) {
      event.preventDefault()
    }
  })
}

function installLongPress(): void {
  let timer: ReturnType<typeof setTimeout> | undefined
  let startX = 0
  let startY = 0
  let pointerId: number | undefined
  let pressed: StoryListItem | undefined

  const cancelPress = () => {
    if (timer !== undefined) clearTimeout(timer)
    timer = undefined
    pointerId = undefined
    pressed?.classList.remove(PRESS_CLASS)
    pressed = undefined
    document.removeEventListener("pointermove", onMove)
    document.removeEventListener("pointerup", cancelPress)
    document.removeEventListener("pointercancel", cancelPress)
  }

  const onMove = (event: PointerEvent) => {
    if (event.pointerId !== pointerId) return
    if (
      Math.abs(event.clientX - startX) > MOVE_TOLERANCE_PX ||
      Math.abs(event.clientY - startY) > MOVE_TOLERANCE_PX
    ) {
      // The press turned into a drag or a scroll — the swipe handler owns it.
      cancelPress()
    }
  }

  // Swallows the click/mouse events the browser synthesizes when the finger
  // lifts after a long-press, so the title link underneath doesn't navigate
  // and menu rows under the finger don't get phantom-tapped. Armed when the
  // menu opens, disarmed shortly after the pointer lifts — never left armed
  // (a stale once-listener would eat the user's next real tap).
  const suppressEvent = (event: Event) => {
    event.preventDefault()
    event.stopPropagation()
    // The synthesized click is the last event of the release sequence;
    // disarm right away so the user's next real tap goes through.
    if (event.type === "click") disarmSuppressor()
  }
  const disarmSuppressor = () => {
    document.removeEventListener("click", suppressEvent, true)
    document.removeEventListener("mousedown", suppressEvent, true)
    document.removeEventListener("mouseup", suppressEvent, true)
  }
  const armSuppressor = () => {
    document.addEventListener("click", suppressEvent, true)
    document.addEventListener("mousedown", suppressEvent, true)
    document.addEventListener("mouseup", suppressEvent, true)
    // Fallback for platforms that don't synthesize a click after long-press.
    document.addEventListener(
      "pointerup",
      () => setTimeout(disarmSuppressor, 250),
      { capture: true, once: true }
    )
  }

  document.addEventListener("pointerdown", (event) => {
    if (isStoryAnchoredMenuOpen()) return
    const story = (event.target as Element | null)?.closest<StoryListItem>(
      "story-item"
    )
    if (!story || !event.isPrimary) return
    cancelPress()
    pointerId = event.pointerId
    startX = event.clientX
    startY = event.clientY
    pressed = story
    story.classList.add(PRESS_CLASS)
    document.addEventListener("pointermove", onMove)
    document.addEventListener("pointerup", cancelPress)
    document.addEventListener("pointercancel", cancelPress)
    timer = setTimeout(() => {
      const target = pressed
      cancelPress()
      // A reload replaces the rows outright. Asking a detached row for its
      // menu would raise the event with no path to the document listener,
      // leaving the suppressor armed against a menu that never opened.
      if (!target?.isConnected) return
      armSuppressor()
      target.requestMenu(target)
    }, LONG_PRESS_MS)
  })
}
