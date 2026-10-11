import { joinBlockLines, ocrParagraphLines } from "@once/app/ocrParagraphs"
import type { ImageTextResult } from "./browser/imageTextTypes"

/**
 * Structure-aware selection over recognized image text, using the reflow
 * Reader applies to OCR: a triple-click selects the word's whole block
 * (paragraph, heading or list item), and copying joins a block's wrapped
 * lines instead of keeping the image's line breaks.
 */
export class ImageTextBlocks {
  private blockOfLine: number[] = []

  constructor(private readonly shadow: ShadowRoot, private readonly words: HTMLElement) {
    words.addEventListener("mousedown", this.tripleClick, true)
    document.addEventListener("copy", this.copy, true)
  }

  attach(result: ImageTextResult): void {
    this.blockOfLine = []
    ocrParagraphLines({ lines: result.textLines, lineBounds: result.lineBounds })
      .forEach((lines, block) => lines.forEach((line) => { this.blockOfLine[line] = block }))
  }

  destroy(): void {
    this.words.removeEventListener("mousedown", this.tripleClick, true)
    document.removeEventListener("copy", this.copy, true)
  }

  private spans(): HTMLElement[] {
    return [...this.words.querySelectorAll<HTMLElement>(".word")]
  }

  private block(span: HTMLElement): number | undefined {
    return this.blockOfLine[Number(span.dataset.line)]
  }

  private readonly tripleClick = (event: MouseEvent) => {
    if (event.detail !== 3 || event.button !== 0) return
    const word = (event.target as Element | null)?.closest<HTMLElement>(".word")
    const block = word ? this.block(word) : undefined
    if (block === undefined) return
    const spans = this.spans().filter((span) => this.block(span) === block)
    const first = spans[0]?.firstChild, last = spans.at(-1)?.firstChild
    if (!(first instanceof Text) || !(last instanceof Text)) return
    event.preventDefault()
    document.getSelection()?.setBaseAndExtent(first, 0, last, last.length)
  }

  private readonly copy = (event: ClipboardEvent) => {
    const text = this.selectedText()
    if (text === null || !event.clipboardData) return
    event.clipboardData.setData("text/plain", text)
    event.preventDefault()
  }

  /** The selection inside the overlay as reflowed text, or null when it is not ours. */
  private selectedText(): string | null {
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed) return null
    const composed = selection.getComposedRanges({ shadowRoots: [this.shadow] })[0]
    if (!composed) return null
    const range = document.createRange()
    range.setStart(composed.startContainer, composed.startOffset)
    range.setEnd(composed.endContainer, composed.endOffset)
    let text = "", previous: HTMLElement | null = null
    for (const span of this.spans()) {
      const node = span.firstChild
      if (!(node instanceof Text) || !range.intersectsNode(node)) continue
      const start = range.comparePoint(node, 0) >= 0 ? 0 : range.startContainer === node ? range.startOffset : node.length
      const end = range.comparePoint(node, node.length) <= 0 ? node.length : range.endContainer === node ? range.endOffset : 0
      const part = node.data.slice(start, end)
      if (!part) continue
      if (!previous) text = part
      else if (previous.dataset.line === span.dataset.line) text += ` ${part}`
      else if (this.block(previous) === this.block(span)) text = joinBlockLines(text, part)
      else text += `\n${part}`
      previous = span
    }
    return previous ? text : null
  }
}
