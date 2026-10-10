import type { RecognizedText } from "./textRetrieval"

/** Bounds use the OCR engine's upright image coordinates, with y increasing downwards. */
export interface TextLineBounds { x: number; y: number; width: number; height: number }

const listItem = /^\s*(?:[•●▪‣*]|[-–—]\s|\(?\d{1,3}[.)]\s|[a-zA-Z][.)]\s)/u
const sentenceEnd = /[.!?。！？]["'”’)]?$/u
const lowercase = /^\p{Ll}/u

function valid(box: TextLineBounds | undefined): box is TextLineBounds {
  return Boolean(box && [box.x, box.y, box.width, box.height].every(Number.isFinite) && box.width > 0 && box.height > 0)
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)] ?? 0
}

/** Reflow line wrapping, preserving paragraph spacing, headings, lists and column boundaries. */
export function ocrParagraphs(result: RecognizedText): string[] {
  const lines = result.lines.map((text, index) => ({ text: text.trim(), box: result.lineBounds?.[index] })).filter(line => line.text)
  const heights = lines.flatMap(line => valid(line.box) ? [line.box.height] : [])
  const typicalHeight = median(heights)
  const gaps: number[] = []
  for (let index = 1; index < lines.length; index++) {
    const previous = lines[index - 1].box, current = lines[index].box
    if (!valid(previous) || !valid(current)) continue
    const gap = current.y - previous.y - previous.height
    if (gap >= 0 && gap < typicalHeight * 1.5 && Math.abs(current.x - previous.x) < typicalHeight * 2) gaps.push(gap)
  }
  const typicalGap = median(gaps)
  const paragraphs: string[] = []
  for (let index = 0; index < lines.length; index++) {
    const current = lines[index], previous = lines[index - 1]
    let join = false
    if (previous && !listItem.test(current.text)) {
      const a = previous.box, b = current.box
      if (valid(a) && valid(b)) {
        const gap = b.y - a.y - a.height
        const height = Math.min(a.height, b.height)
        const overlap = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)
        const sameSize = Math.max(a.height, b.height) / height < 1.35
        const aligned = Math.abs(a.x - b.x) < height * 1.5 || listItem.test(previous.text)
        // A short standalone line is more likely a heading/signature than a wrapped line.
        const heading = a.width < b.width * 0.55 && !sentenceEnd.test(previous.text) && !lowercase.test(current.text)
        join = sameSize && aligned && overlap > 0 && !heading &&
          gap >= -height * 0.35 && gap <= typicalGap + typicalHeight * 0.4
      } else {
        // Text-only backends cannot distinguish a new paragraph from a new line.
        // Only join a clear sentence continuation; never merge list items/headings blindly.
        join = !sentenceEnd.test(previous.text) && !/[:：]$/.test(previous.text) && lowercase.test(current.text)
      }
    }
    if (join) {
      const last = paragraphs.length - 1
      const text = paragraphs[last]
      const separator = /[\p{L}][-\u00ad]$/u.test(text) && lowercase.test(current.text) ? "" : " "
      paragraphs[last] = text.replace(/\u00ad$/u, "") + separator + current.text
    } else paragraphs.push(current.text)
  }
  return paragraphs
}
