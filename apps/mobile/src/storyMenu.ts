/**
 * Story actions on touch.
 *
 * Two gestures reach the same menu at the same anchor: a tap on the row's ⋮
 * button, and a long-press anywhere else on the row. Both raise
 * StoryMenuRequestEvent from the row, and this module answers it with the
 * platform-native menu when available or the shared DOM menu in a web harness.
 */

import type { InAppBrowserSurface } from "@once/platform-mobile"
import {
  describeStoryMenu,
  executeStoryMenuAction,
  getOnceClient,
  isStoryAnchoredMenuOpen,
  openStoryAnchoredMenu,
  STORY_MENU_REQUEST,
  StoryListItem,
  StoryMenuActionId,
  StoryMenuRequestEvent
} from "@once/ui-web"

const LONG_PRESS_MS = 500
const MOVE_TOLERANCE_PX = 10
/** Marks the row while the long-press builds; drives the progress line. */
const PRESS_CLASS = "press_building"
let nativeMenuOpen = false

/** The tab bar is fixed to the bottom; the menu must never hide behind it. */
function tabBarHeight(): number {
  const menu = document.querySelector<HTMLElement>("#menu")
  if (!menu) return 0
  return Math.round(menu.getBoundingClientRect().height)
}

function buildChannel(): "release" | "dev" {
  return document.body.dataset.buildChannel === "dev" ? "dev" : "release"
}

export function installStoryMenu(surface?: InAppBrowserSurface): void {
  document.addEventListener(STORY_MENU_REQUEST, (event) => {
    const request = event as StoryMenuRequestEvent
    if (surface?.available) {
      if (nativeMenuOpen) return
      void openNativeStoryMenu(surface, request)
      return
    }
    openDomStoryMenu(request)
  })

  installLongPress()

  // Android fires contextmenu on long-press; Once supplies the menu itself.
  document.addEventListener("contextmenu", (event) => {
    if ((event.target as Element | null)?.closest("story-item")) {
      event.preventDefault()
    }
  })
}

function openDomStoryMenu(request: StoryMenuRequestEvent): void {
  openStoryAnchoredMenu({
    anchor: request.anchor,
    bottomInset: tabBarHeight(),
    context: {
      platform: "mobile",
      buildChannel: buildChannel(),
      story: request.story
    },
    onClose: notifyMenuClosed
  })
}

async function openNativeStoryMenu(
  surface: InAppBrowserSurface,
  request: StoryMenuRequestEvent
): Promise<void> {
  nativeMenuOpen = true
  let usingDomFallback = false
  const rect = request.anchor.getBoundingClientRect()
  const descriptors = describeStoryMenu({
    platform: "mobile",
    buildChannel: buildChannel(),
    story: request.story
  }).filter((item) => item.visible)
  try {
    const selected = await surface.showMenu({
      title: "Story actions",
      anchor: {
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height
      },
      items: descriptors.map(({ id, label, enabled }) => ({
        id,
        label,
        enabled
      }))
    }) as StoryMenuActionId | null
    if (!selected) return
    if (
      selected === "filter" &&
      !request.story.classList.contains("filtered")
    ) {
      await showNativeFilterPrompt(surface, request.story)
      return
    }
    await executeStoryMenuAction(selected, request.story)
  } catch (error) {
    console.error("Unable to show the native story menu", error)
    usingDomFallback = true
    await surface.setVisible(false)
    openDomStoryMenu(request)
  } finally {
    nativeMenuOpen = false
    if (!usingDomFallback) notifyMenuClosed()
  }
}

async function showNativeFilterPrompt(
  surface: InAppBrowserSurface,
  story: StoryListItem
): Promise<void> {
  const value = await surface.showPrompt({
    title: "Filter source",
    message: "Filter stories matching:",
    value: new URL(story.story.href).hostname,
    confirmLabel: "Add filter",
    cancelLabel: "Cancel"
  })
  if (value === null) return
  await getOnceClient().addFilter(value)
}

function notifyMenuClosed(): void {
  document.dispatchEvent(new CustomEvent("once-story-menu-closed"))
}

/** The swipe settings sample row has no real story behind it: no menu. */
function isPreviewRow(story: StoryListItem): boolean {
  return story.dataset.swipePreview === "true"
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
    if (nativeMenuOpen || isStoryAnchoredMenuOpen()) return
    const story = (event.target as Element | null)?.closest<StoryListItem>(
      "story-item"
    )
    if (!story || !event.isPrimary || isPreviewRow(story)) return
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
