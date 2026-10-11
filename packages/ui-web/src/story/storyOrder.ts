function nextRow(row: Element, rowClass: string): Element | null {
  let next = row.nextElementSibling
  while (next && !next.classList.contains(rowClass)) next = next.nextElementSibling
  return next
}

/**
 * Puts the rows of `container` into `sorted` order, moving only rows that are
 * out of place and none at all when the order already holds.
 *
 * Re-appending every row on every batch moved the whole list several times
 * per reload. A row that a new story lands above stays where it is; only the
 * newcomer moves. Other children (the pull-to-refresh strip) keep their place.
 *
 * @returns how many rows moved
 */
export function placeInOrder(
  container: Element,
  sorted: readonly Element[],
  rowClass = "story"
): number {
  let cursor = Array.from(container.children)
    .find((child) => child.classList.contains(rowClass)) ?? null
  let moved = 0
  for (const row of sorted) {
    if (row === cursor) {
      cursor = nextRow(row, rowClass)
      continue
    }
    if (cursor) container.insertBefore(row, cursor)
    else container.appendChild(row)
    moved++
  }
  return moved
}
