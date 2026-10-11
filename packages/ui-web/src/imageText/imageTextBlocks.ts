import { joinBlockLines, ocrParagraphLines } from "@once/app/ocrParagraphs"
import type { ImageTextResult } from "./imageTextTypes"

/**
 * Structure-aware selection over recognized image text, using the reflow
 * Reader applies to OCR: a triple-click selects the word's whole block
 * (paragraph, heading or list item), and copying joins a block's wrapped
 * lines instead of keeping the image's line breaks.
 */
export class ImageTextBlocks {
  private blockOfLine: number[] = []

  /**
   * `words` holds the `.word` spans, in the page or in Android's text layer
   * (whose own document receives its native toolbar's copy); `range` is the
   * selection over them, or null.
   */
  constructor(private readonly words: HTMLElement, private readonly range: () => Range | null) {
    words.addEventListener("mousedown", this.tripleClick, true)
    words.ownerDocument.addEventListener("copy", this.copy, true)
    // The bar's Copy button runs in the page, so its copy event fires there.
    if (words.ownerDocument !== document) document.addEventListener("copy", this.copyPending, true)
  }

  attach(result: ImageTextResult): void {
    this.blockOfLine = []
    ocrParagraphLines({ lines: result.textLines, lineBounds: result.lineBounds })
      .forEach((lines, block) => lines.forEach((line) => { this.blockOfLine[line] = block }))
  }

  destroy(): void {
    this.words.removeEventListener("mousedown", this.tripleClick, true)
    this.words.ownerDocument.removeEventListener("copy", this.copy, true)
    document.removeEventListener("copy", this.copyPending, true)
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
    if (!isText(first) || !isText(last)) return
    event.preventDefault()
    this.words.ownerDocument.getSelection()?.setBaseAndExtent(first, 0, last, last.length)
  }

  private pending: string | null = null

  /**
   * Copies the selection inside the overlay, or all recognized text when
   * nothing there is selected, from a click handler (a user gesture). The copy
   * event below supplies the text, so no secure context is needed.
   */
  copyFromGesture(): boolean {
    this.pending = this.selectedText() ?? this.allText()
    try {
      return document.execCommand("copy")
    } finally {
      this.pending = null
    }
  }

  private readonly copy = (event: ClipboardEvent) => this.supply(event, this.pending ?? this.selectedText())

  /** A copy in the page that is not the bar's is the page's own. */
  private readonly copyPending = (event: ClipboardEvent) => this.supply(event, this.pending)

  private supply(event: ClipboardEvent, text: string | null): void {
    if (text === null || !event.clipboardData) return
    event.clipboardData.setData("text/plain", text)
    event.preventDefault()
  }

  private allText(): string {
    return this.join(this.spans().map((span) => ({ span, part: isText(span.firstChild) ? span.firstChild.data : "" })))
  }

  /** Words of one line joined by spaces, wrapped lines of one block reflowed, blocks on new lines. */
  private join(parts: { span: HTMLElement; part: string }[]): string {
    let text = "", previous: HTMLElement | null = null
    for (const { span, part } of parts) {
      if (!part) continue
      if (!previous) text = part
      else if (previous.dataset.line === span.dataset.line) text += ` ${part}`
      else if (this.block(previous) === this.block(span)) text = joinBlockLines(text, part)
      else text += `\n${part}`
      previous = span
    }
    return text
  }

  /** The selection inside the overlay as reflowed text, or null when it is not ours. */
  private selectedText(): string | null {
    const range = this.range()
    if (!range) return null
    const parts = this.spans().flatMap((span) => {
      const node = span.firstChild
      if (!isText(node) || !range.intersectsNode(node)) return []
      const start = range.comparePoint(node, 0) >= 0 ? 0 : range.startContainer === node ? range.startOffset : node.length
      const end = range.comparePoint(node, node.length) <= 0 ? node.length : range.endContainer === node ? range.endOffset : 0
      return [{ span, part: node.data.slice(start, end) }]
    })
    const text = this.join(parts)
    return text ? text : null
  }
}

/** A text node from any realm: Android's layer lives in an iframe, where `instanceof Text` fails. */
function isText(node: Node | null | undefined): node is Text {
  return node?.nodeType === Node.TEXT_NODE
}
