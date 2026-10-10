import type { RecognizedText } from "@once/app"

export interface PdfTextItem {
  str: string; width: number; height: number; transform: number[]; hasEOL: boolean
}

/** Combine positioned text runs into lines before applying the shared paragraph rules. */
export function pdfTextLines(items: PdfTextItem[], transform: (matrix: number[]) => number[]): RecognizedText {
  const lines: string[] = []
  const lineBounds: NonNullable<RecognizedText["lineBounds"]> = []
  let text = "", box: NonNullable<RecognizedText["lineBounds"]>[number] | undefined
  const flush = () => {
    if (text.trim() && box) { lines.push(text.trim()); lineBounds.push(box) }
    text = ""; box = undefined
  }
  for (const item of items) {
    if (!item.str.trim()) { if (item.hasEOL) flush(); continue }
    const matrix = transform(item.transform)
    const height = Math.hypot(matrix[2], matrix[3]) || item.height || 1
    const next = { x: matrix[4], y: matrix[5] - height, width: Math.abs(item.width), height }
    if (box && (Math.abs(next.y - box.y) > Math.min(height, box.height) * 0.45 ||
      next.x > box.x + box.width + height * 4 || next.x + next.width < box.x - height)) flush()
    if (box) {
      const space = next.x - (box.x + box.width) > height * 0.12 && !/\s$/.test(text) && !/^\s/.test(item.str) ? " " : ""
      text += space + item.str
      const right = Math.max(box.x + box.width, next.x + next.width)
      const bottom = Math.max(box.y + box.height, next.y + next.height)
      box.x = Math.min(box.x, next.x); box.y = Math.min(box.y, next.y)
      box.width = right - box.x; box.height = bottom - box.y
    } else { text = item.str; box = next }
    if (item.hasEOL) flush()
  }
  flush()
  return { lines, lineBounds }
}
