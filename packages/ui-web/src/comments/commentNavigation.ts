// Moving through a comment tree laid out as a flat list in reading order, the
// way the Hacker News navigator userscript does:
//   Down/Up      next/previous comment at the same or a shallower level;
//   Right        expand a collapsed comment, or step into its first reply;
//   Left         collapse an expanded comment and move on to the next expanded
//                one; on a collapsed comment, go to its parent.
// No DOM here, so the rules can be tested on their own.

export interface NavComment {
  depth: number
  collapsed: boolean
  /** Inside a collapsed ancestor. */
  hidden: boolean
}

type Items = readonly NavComment[]

/** From `from` (exclusive) in direction `step`, the first item matching `pred`, or -1. */
function findIndex(items: Items, from: number, step: 1 | -1, pred: (item: NavComment) => boolean): number {
  for (let i = from + step; i >= 0 && i < items.length; i += step) {
    if (pred(items[i])) return i
  }
  return -1
}

const visible = (item: NavComment) => !item.hidden

/** The next or previous visible comment no deeper than the one at `from`. */
export function siblingOrAncestor(items: Items, from: number, step: 1 | -1): number {
  const depth = items[from].depth
  return findIndex(items, from, step, item => visible(item) && item.depth <= depth)
}

export function parentOf(items: Items, from: number): number {
  const depth = items[from].depth
  return depth === 0 ? -1 : findIndex(items, from, -1, item => item.depth < depth)
}

export function firstReplyOf(items: Items, from: number): number {
  const item = items[from]
  if (item.collapsed) return -1
  const next = items[from + 1]
  return next && next.depth === item.depth + 1 && visible(next) ? from + 1 : -1
}

/** Down: the first visible comment when nothing is selected yet. */
export function nextIndex(items: Items, from: number): number {
  if (from < 0) return findIndex(items, -1, 1, visible)
  return siblingOrAncestor(items, from, 1)
}

/** Up: nothing to go back to before a first selection. */
export function previousIndex(items: Items, from: number): number {
  if (from < 0) return -1
  return siblingOrAncestor(items, from, -1)
}

/** What Left does: whether to collapse the current comment, and where to go. */
export function collapseStep(items: Items, from: number): { collapse: boolean; target: number } {
  if (from < 0) return { collapse: false, target: -1 }
  const item = items[from]
  if (!item.collapsed) {
    // Replies of the collapsed comment are deeper, so the depth rule skips them.
    const target = findIndex(items, from, 1, next => visible(next) && !next.collapsed && next.depth <= item.depth)
    return { collapse: true, target }
  }
  return { collapse: false, target: parentOf(items, from) }
}

/** What Right does: whether to expand the current comment, and where to go. */
export function expandStep(items: Items, from: number): { expand: boolean; target: number } {
  if (from < 0) return { expand: false, target: -1 }
  if (items[from].collapsed) return { expand: true, target: from }
  return { expand: false, target: firstReplyOf(items, from) }
}
