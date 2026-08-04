import { StoryListItem } from "./StoryListItem"
import { commitSwipeAction } from "./swipe/commit"
import { SwipeConfig } from "./swipe/geometry"
import { revealElement } from "../scrollReveal"
import { visibleStoryElements } from "./storyVisibility"

/** Buckets the cursor may live in, most specific first. */
const BUCKETS = ["global_search_results", "filtered_stories", "stories"] as const
type CursorBucket = typeof BUCKETS[number]

/**
 * Keyboard position in the story list.
 *
 * The cursor remembers an href rather than an element: rows are rebuilt in
 * place by StoryListItem.update_complete_story_el(), replaced outright by
 * storyList's refilter(), and reparented by sortStories() after a read-state
 * change. An element reference would not survive any of those; an href does.
 *
 * It is deliberately unrelated to the `.selected` row in #selected_container,
 * which mirrors whatever the browser pane is showing. That container also
 * duplicates a row for the open story, which is why it is never a cursor
 * bucket — one href would otherwise match two elements.
 */
export class StoryCursor {
  private href: string | null = null
  private lastIndex = 0
  private bucket: CursorBucket = "stories"
  private observer: MutationObserver | null = null

  mount(): void {
    if (this.observer) return
    // Clicking a story adopts it as the cursor, so switching between mouse and
    // keyboard continues from the row the user just looked at.
    document.addEventListener("click", (event) => this.adoptClick(event))
    // refilter() replaces rows wholesale, so the marker has to be re-applied
    // after the list changes rather than merely set once.
    this.observer = new MutationObserver(() => this.refresh())
    for (const bucket of BUCKETS) {
      const container = document.querySelector(`#${bucket}`)
      if (container) this.observer.observe(container, { childList: true })
    }
  }

  unmount(): void {
    this.observer?.disconnect()
    this.observer = null
  }

  current(): StoryListItem | null {
    const rows = this.rows()
    const index = this.indexOf(rows)
    return index === -1 ? null : rows[index]
  }

  /** Moves by whole rows, entering the list at the top when unset. */
  moveBy(delta: number): void {
    const rows = this.rows()
    if (rows.length === 0) return
    const index = this.indexOf(rows)
    // A vanished row (skipped and re-sorted away, purged, refiltered) resumes
    // from where it used to be instead of jumping back to the top.
    const next = index === -1
      ? clamp(this.lastIndex + (delta > 0 ? 0 : delta), rows.length)
      : clamp(index + delta, rows.length)
    this.select(rows[next], next)
  }

  /**
   * Runs the configured first-stage swipe action for a direction, then steps
   * to the next row.
   *
   * The cursor deliberately does not follow the story it just acted on: after
   * a skip that story is done with, and read-state changes re-sort it out from
   * under the cursor anyway. The successor is resolved before the action runs,
   * while the old order is still intact.
   */
  runSwipeAction(direction: -1 | 1): void {
    const rows = this.rows()
    const index = this.indexOf(rows)
    const row = index === -1 ? null : rows[index]
    if (!row) return
    // Stage 1 is the shallow detent — the "first action" a short swipe commits.
    const action = SwipeConfig.actionAt(1, direction)
    if (action === "none") return
    const successor = rows[index + 1] ?? rows[index - 1] ?? null
    const successorHref = successor?.dataset.href ?? null
    commitSwipeAction(row, action)
    if (successorHref) this.selectHref(successorHref)
  }

  run(action: (row: StoryListItem) => void): void {
    const row = this.current()
    if (row) action(row)
  }

  /** Re-applies the marker after the list was rebuilt underneath it. */
  refresh(): void {
    const rows = this.rows()
    const index = this.indexOf(rows)
    if (index === -1) return
    this.select(rows[index], index, { reveal: false })
  }

  /** Moves onto a named story, following it with focus and a scroll. */
  selectHref(href: string): void {
    const rows = this.rows()
    const index = rows.findIndex((row) => row.dataset.href === href)
    if (index === -1) return
    this.select(rows[index], index)
  }

  private adoptClick(event: Event): void {
    const target = event.target as Element | null
    if (typeof target?.closest !== "function") return
    const clicked = target.closest<StoryListItem>("story-item.story")
    if (!clicked) return
    const rows = this.rows()
    const index = rows.indexOf(clicked)
    // Ignore the mirrored row in #selected_container, and anything outside the
    // bucket the cursor is currently working in.
    if (index === -1) return
    // Clicking the row itself moves the keyboard here too, so the arrows carry
    // straight on. Clicking a link or button inside it must not, because the
    // click has already aimed focus at that control.
    const onControl = target.closest("a, button, input, select, textarea, [tabindex]")
    const claimsFocus = Boolean(onControl) && onControl !== clicked
    this.select(clicked, index, { reveal: false })
    if (!claimsFocus) clicked.focus()
  }

  private select(
    row: StoryListItem,
    index: number,
    options: { reveal?: boolean } = {}
  ): void {
    for (const other of document.querySelectorAll<StoryListItem>("story-item.cursor")) {
      if (other === row) continue
      other.classList.remove("cursor")
      other.removeAttribute("aria-current")
      other.setAttribute("tabindex", "-1")
    }
    this.href = row.dataset.href || null
    this.lastIndex = index
    row.classList.add("cursor")
    row.setAttribute("aria-current", "true")
    // Roving tabindex rather than aria-activedescendant: a row is a compound
    // widget with its own links and buttons, so it must be a real tab stop.
    row.setAttribute("tabindex", "0")
    if (options.reveal === false) return
    row.focus()
    revealElement(row, { block: "nearest" })
  }

  private indexOf(rows: StoryListItem[]): number {
    if (!this.href) return -1
    return rows.findIndex((row) => row.dataset.href === this.href)
  }

  /** The rows of whichever single bucket is currently on screen. */
  private rows(): StoryListItem[] {
    this.bucket = activeBucket()
    return visibleStoryElements(this.bucket)
  }
}

/**
 * Puts keyboard focus back into the story list — the cursor row when there is
 * one, otherwise the search field so the list is at least reachable.
 */
export function focusStoryList(): void {
  const cursor = document.querySelector<HTMLElement>("story-item.cursor")
  if (cursor) {
    cursor.focus()
    revealElement(cursor, { block: "nearest" })
    return
  }
  document.querySelector<HTMLElement>("#searchfield")?.focus()
}

function activeBucket(): CursorBucket {
  const globalResults = document.querySelector("#global_search_results")
  if (globalResults?.classList.contains("search-visible")) return "global_search_results"
  if (document.querySelector("#stories")?.classList.contains("show_filtered")) {
    return "filtered_stories"
  }
  return "stories"
}

function clamp(index: number, length: number): number {
  if (index < 0) return 0
  return index > length - 1 ? length - 1 : index
}
