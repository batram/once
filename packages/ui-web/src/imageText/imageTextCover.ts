import type { ImageTextFit } from "./imageTextTypes"

type Box = ImageTextFit["visibleBox"]

/**
 * Whether the element is what shows at a viewport point, rather than something
 * the page draws over it; `ignore` skips the app's own elements over it.
 */
function showsElement(element: Element, x: number, y: number, ignore?: (candidate: Element) => boolean): boolean {
  const top = ignore ? document.elementsFromPoint(x, y).find((candidate) => !ignore(candidate)) : document.elementFromPoint(x, y)
  // An ancestor answers for an image with pointer-events: none.
  return Boolean(top && (top === element || top.contains(element)))
}

/**
 * The visible box less the bands the page covers at its edges: fixed
 * headers, banners and dialogs over the image. The selection is drawn above
 * the whole page, so without this it would show through them.
 * Each edge moves in only as far as every sampled line agrees it is covered,
 * so a small badge in one corner keeps the box whole; when no sample shows
 * the element at all, something transparent covers it and the box stays.
 */
export function uncoveredBox(element: Element, box: Box, ignore?: (candidate: Element) => boolean): Box {
  const shows = (x: number, y: number) => showsElement(element, x, y, ignore)
  const result = { ...box }
  const lines = (from: number, to: number) => [0.2, 0.5, 0.8].map((at) => from + (to - from) * at)
  // The first point from `start` towards `end` where the image shows, or null.
  const firstShown = (start: number, end: number, at: (position: number) => boolean): number | null => {
    const direction = Math.sign(end - start), step = Math.max(4, Math.abs(end - start) / 48)
    let miss = start
    for (let position = start; direction * (end - position) >= 0; position += direction * step) {
      if (at(position)) {
        // Refine between the last covered sample and this one.
        let shown = position
        while (Math.abs(shown - miss) > 1) {
          const middle = (shown + miss) / 2
          if (at(middle)) shown = middle
          else miss = middle
        }
        return shown
      }
      miss = position
    }
    return null
  }
  const edge = (hits: (number | null)[], pick: (values: number[]) => number) => {
    const found = hits.filter((hit): hit is number => hit !== null)
    return found.length ? pick(found) : null
  }
  const inset = 0.5
  const columns = lines(box.left + inset, box.right - inset)
  const top = edge(columns.map((x) => firstShown(box.top + inset, box.bottom - inset, (y) => shows(x, y))), (v) => Math.min(...v))
  if (top === null) return result
  const bottom = edge(columns.map((x) => firstShown(box.bottom - inset, box.top + inset, (y) => shows(x, y))), (v) => Math.max(...v))
  result.top = Math.max(box.top, Math.floor(top))
  result.bottom = Math.min(box.bottom, Math.ceil((bottom ?? box.bottom) + inset))
  const rows = lines(result.top + inset, result.bottom - inset)
  const left = edge(rows.map((y) => firstShown(box.left + inset, box.right - inset, (x) => shows(x, y))), (v) => Math.min(...v))
  const right = edge(rows.map((y) => firstShown(box.right - inset, box.left + inset, (x) => shows(x, y))), (v) => Math.max(...v))
  if (left !== null) result.left = Math.max(box.left, Math.floor(left))
  if (right !== null) result.right = Math.min(box.right, Math.ceil(right + inset))
  return result
}
