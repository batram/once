/** The lists whose off-screen rows are skipped, see stories.css. */
const ROW_LISTS = ["stories", "filtered_stories", "global_search_results"]

/** How long a list has to stay quiet before its rows are measured. */
const QUIET_MS = 150
/** A list that never goes quiet (stories streaming in) is measured this often. */
const MAX_WAIT_MS = 1000

/**
 * Keeps the height of every row known while off-screen rows are skipped.
 *
 * A skipped row has no layout, so the list stands in the height it last had,
 * and a guess for a row never rendered. Guesses are wrong by a few pixels a
 * row: the list's height then changed as it was scrolled, and a scrollbar
 * thumb being dragged slid away from under the pointer.
 *
 * So whenever heights may have gone stale (rows added or removed, or the list
 * getting a different width, which rewraps titles) every row is rendered for
 * two frames. The first lays the rows out; the engine records their heights
 * at the end of that frame, and the second finds them recorded.
 *
 * A row whose content changes while it is skipped keeps its old height until
 * it is next shown. That is one row's difference, not the whole list's.
 */
export function keepRowHeightsMeasured(list: HTMLElement): void {
  let quiet: ReturnType<typeof setTimeout> | null = null
  let waitingSince = 0
  let width = -1

  const measure = () => {
    quiet = null
    waitingSince = 0
    list.dataset.measuringRows = "true"
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        delete list.dataset.measuringRows
      })
    })
  }
  const queue = () => {
    const now = Date.now()
    if (waitingSince === 0) waitingSince = now
    if (quiet !== null) clearTimeout(quiet)
    const wait = Math.max(0, Math.min(QUIET_MS, waitingSince + MAX_WAIT_MS - now))
    quiet = setTimeout(measure, wait)
  }

  // Rows only: a swipe puts its reveal layer into the list and takes it out
  // again, and measuring then would render every row in the middle of a drag.
  const isRow = (node: Node) => node.nodeName === "STORY-ITEM"
  new MutationObserver((records) => {
    const rowsChanged = records.some((record) =>
      [...record.addedNodes].some(isRow) || [...record.removedNodes].some(isRow)
    )
    if (rowsChanged) queue()
  }).observe(list, { childList: true })
  new ResizeObserver(() => {
    // Height changes are the list being scrolled into or filtered, not a
    // reason to measure; only a new width rewraps the rows.
    if (list.clientWidth === width) return
    width = list.clientWidth
    queue()
  }).observe(list)
}

/** Starts measuring for each story list, where rows are skipped at all. */
export function initRowHeights(): void {
  if (typeof ResizeObserver === "undefined" ||
      typeof MutationObserver === "undefined" ||
      typeof matchMedia !== "function") {
    return
  }
  // The same conditions as the stylesheets': without the media query no row
  // is skipped, and the mobile sheet turns skipping off altogether.
  if (!matchMedia("(hover: hover) and (pointer: fine)").matches) return
  if (document.body.dataset.platform === "mobile") return
  for (const id of ROW_LISTS) {
    const list = document.getElementById(id)
    if (list) keepRowHeightsMeasured(list)
  }
}
