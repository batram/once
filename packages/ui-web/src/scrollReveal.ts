export type RevealAlignment = "start" | "center" | "nearest"

export interface RevealOptions {
  block?: RevealAlignment
  inline?: RevealAlignment
}

/**
 * Scrolls the element into view inside the scroll container it belongs to.
 *
 * `scrollIntoView` cannot be aimed: it walks the whole ancestor chain and
 * scrolls every scroll box on it, including the ones that only exist because a
 * layout box overflows its clipped parent by a few pixels. Those containers
 * have no scrollbar and ignore the wheel, so once one of them drifts the user
 * cannot scroll it back and the app chrome stays pushed under the window frame
 * until the next reload. Revealing a story source inside the settings panel is
 * how it showed up, but any reveal on any panel could have done it.
 *
 * So aim it: find the nearest ancestor the user could scroll themselves, move
 * that one, and leave every clipped container alone. An element with no
 * scrollable ancestor is already as visible as scrolling can make it.
 */
export function revealElement(
  element: Element,
  options: RevealOptions = {}
): void {
  const block = options.block || "nearest"
  const inline = options.inline || "nearest"
  const bounds = element.getBoundingClientRect()
  const view = element.ownerDocument.defaultView
  if (typeof view?.getComputedStyle !== "function") return

  const vertical = scrollableAncestor(element, "y", view)
  if (vertical) {
    const box = vertical.getBoundingClientRect()
    vertical.scrollTop = clamp(
      vertical.scrollTop + offset(
        bounds.top - box.top - vertical.clientTop,
        bounds.height,
        vertical.clientHeight,
        block
      ),
      vertical.scrollHeight - vertical.clientHeight
    )
  }

  const horizontal = scrollableAncestor(element, "x", view)
  if (!horizontal) return
  const box = horizontal.getBoundingClientRect()
  horizontal.scrollLeft = clamp(
    horizontal.scrollLeft + offset(
      bounds.left - box.left - horizontal.clientLeft,
      bounds.width,
      horizontal.clientWidth,
      inline
    ),
    horizontal.scrollWidth - horizontal.clientWidth
  )
}

/**
 * A container counts only when the user could scroll it too: its overflow is
 * scrollable rather than clipped, and it has something to scroll. Clipped
 * containers are skipped rather than treated as the target, so a stray pixel of
 * overflow never becomes the thing that moves.
 */
function scrollableAncestor(
  element: Element,
  axis: "x" | "y",
  view: Window
): HTMLElement | null {
  let node = element.parentElement
  while (node) {
    const style = view.getComputedStyle(node)
    const overflow = axis === "y" ? style.overflowY : style.overflowX
    const extent = axis === "y"
      ? node.scrollHeight - node.clientHeight
      : node.scrollWidth - node.clientWidth
    if (extent > 0 &&
        (overflow === "auto" || overflow === "scroll" ||
         overflow === "overlay")) {
      return node
    }
    node = node.parentElement
  }
  return null
}

/** How far the container must move to satisfy the requested alignment. */
function offset(
  start: number,
  size: number,
  viewport: number,
  alignment: RevealAlignment
): number {
  if (alignment === "start") return start
  if (alignment === "center") return start - (viewport - size) / 2
  if (start < 0) return start
  if (start + size > viewport) return start + size - viewport
  return 0
}

function clamp(value: number, max: number): number {
  return Math.max(0, Math.min(value, Math.max(0, max)))
}
