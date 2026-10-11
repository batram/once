/**
 * Input over the image text overlay. While it is open the overlay covers the
 * whole image, so the image's own behaviour (dragging it out, click-to-zoom in
 * image documents, link or lightbox handlers, the touch image menu) pauses,
 * and every gesture selects text instead:
 * - mouse: a drag anywhere on the image sweeps a selection, precise inside a
 *   word and snapping to the nearest word over gaps or past the image's edge;
 *   shift-click extends; double- and triple-click stay word and block;
 * - touch: Gecko's native carets hit-test whatever lies under a finger, which
 *   between words is the image or the page, so touch gets its own model: tap
 *   or long-press a word to select it, drag the two handles to extend by word.
 * Selections are ordinary DOM selections, so highlights and copying work alike.
 */

interface Caret { node: Text; offset: number }
type Snap = "nearest" | "start" | "end"

const LONG_PRESS_MS = 450
const TAP_SLOP = 10 // px a finger may move and still tap
const EDGE = 28 // px from the viewport edge where a drag autoscrolls

export class ImageTextPointer {
  private anchor: Caret | null = null
  private dragging = false
  private pointer = { x: 0, y: 0 }
  private scrolling = 0
  private press: { x: number; y: number; at: number } | null = null
  private longPress = 0
  private lastPointerType = "mouse"
  private readonly handles: HTMLElement[]

  constructor(private readonly shadow: ShadowRoot, private readonly clip: HTMLElement,
    private readonly words: HTMLElement, private readonly image: HTMLImageElement,
    private readonly onDrag: (dragging: boolean) => void) {
    this.handles = ["start", "end"].map((end) => {
      const handle = document.createElement("div")
      handle.className = `handle ${end}`
      handle.hidden = true
      handle.addEventListener("pointerdown", (event) => this.dragHandle(event, end === "start"))
      shadow.append(handle)
      return handle
    })
    clip.addEventListener("mousedown", this.mousedown)
    clip.addEventListener("pointerdown", this.pointerdown)
    clip.addEventListener("pointermove", this.pointermove)
    clip.addEventListener("pointerup", this.pointerup)
    clip.addEventListener("pointercancel", this.cancelPress)
    clip.addEventListener("contextmenu", this.contextmenu)
    clip.addEventListener("wheel", this.wheel, { passive: false })
    document.addEventListener("keydown", this.keydown, true)
  }

  destroy(): void {
    this.endDrag()
    clearTimeout(this.longPress)
    document.removeEventListener("keydown", this.keydown, true)
    for (const handle of this.handles) handle.remove()
  }

  /** Each layout frame: touch handles follow the selection's ends. */
  update(): void {
    const range = this.range()
    const show = this.lastPointerType !== "mouse" && range !== null
    const rects = show ? [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0) : []
    const [first, last] = [rects[0], rects.at(-1)]
    this.handles.forEach((handle, index) => {
      const rect = index === 0 ? first : last
      handle.hidden = !rect
      if (!rect) return
      handle.style.left = `${index === 0 ? rect.left : rect.right}px`
      handle.style.top = `${rect.bottom}px`
    })
  }

  /** Selects all recognized text. */
  selectAll(): void {
    const spans = this.spans()
    const first = spans[0]?.firstChild, last = spans.at(-1)?.firstChild
    if (first instanceof Text && last instanceof Text) this.select({ node: first, offset: 0 }, { node: last, offset: last.length })
  }

  private spans(): HTMLElement[] {
    return [...this.words.querySelectorAll<HTMLElement>(".word")]
  }

  /** The selection inside the overlay, or null. */
  private range(): Range | null {
    const selection = document.getSelection()
    if (!selection || selection.isCollapsed) return null
    const composed = selection.getComposedRanges({ shadowRoots: [this.shadow] })[0]
    if (!composed || composed.startContainer.getRootNode() !== this.shadow) return null
    const range = document.createRange()
    range.setStart(composed.startContainer, composed.startOffset)
    range.setEnd(composed.endContainer, composed.endOffset)
    return range
  }

  private select(anchor: Caret, focus: Caret): void {
    document.getSelection()?.setBaseAndExtent(anchor.node, anchor.offset, focus.node, focus.offset)
  }

  /**
   * The text position for a point: the exact character inside a word, else
   * the nearest word on the nearest line, at its start or end.
   */
  private caretAt(x: number, y: number, snap: Snap = "nearest"): Caret | null {
    if (snap === "nearest") {
      const position = caretPosition(x, y, this.shadow)
      if (position && position.offsetNode instanceof Text && this.words.contains(position.offsetNode)) {
        return { node: position.offsetNode, offset: position.offset }
      }
    }
    let best: { node: Text; rect: DOMRect } | null = null
    let bestScore = Infinity
    for (const span of this.spans()) {
      const node = span.firstChild
      if (!(node instanceof Text)) continue
      const rect = span.getBoundingClientRect()
      const dx = Math.max(rect.left - x, 0, x - rect.right)
      const dy = Math.max(rect.top - y, 0, y - rect.bottom)
      // Staying on the pointer's line matters more than horizontal closeness.
      const score = dy * 6 + dx
      if (score < bestScore) { bestScore = score; best = { node, rect } }
    }
    if (!best) return null
    const end = snap === "end" || (snap === "nearest" && x > (best.rect.left + best.rect.right) / 2)
    return { node: best.node, offset: end ? best.node.length : 0 }
  }

  private readonly mousedown = (event: MouseEvent) => {
    // Pointer events come first; a tap's compatibility mousedown is not a sweep.
    if (this.lastPointerType !== "mouse" || event.button !== 0 || event.detail > 1) return
    const caret = this.caretAt(event.clientX, event.clientY)
    if (!caret) return
    // Our own sweep replaces native selection, image drag and click-to-zoom.
    event.preventDefault()
    if (!(event.shiftKey && this.anchor)) this.anchor = caret
    this.select(this.anchor, caret)
    this.dragging = true
    this.onDrag(true)
    this.pointer = { x: event.clientX, y: event.clientY }
    window.addEventListener("mousemove", this.mousemove, true)
    window.addEventListener("mouseup", this.mouseup, true)
  }

  private readonly mousemove = (event: MouseEvent) => {
    if (!this.dragging || !this.anchor) return
    this.pointer = { x: event.clientX, y: event.clientY }
    const caret = this.caretAt(event.clientX, event.clientY)
    if (caret) this.select(this.anchor, caret)
    if (!this.scrolling && this.edgeSpeed() !== 0) this.scrolling = requestAnimationFrame(this.autoscroll)
  }

  private readonly mouseup = () => this.endDrag()

  private endDrag(): void {
    if (this.dragging) this.onDrag(false)
    this.dragging = false
    cancelAnimationFrame(this.scrolling)
    this.scrolling = 0
    window.removeEventListener("mousemove", this.mousemove, true)
    window.removeEventListener("mouseup", this.mouseup, true)
  }

  /** Vertical scroll speed while a sweep holds the pointer near the viewport's edge. */
  private edgeSpeed(): number {
    const height = document.scrollingElement?.clientHeight || innerHeight
    if (this.pointer.y < EDGE) return -Math.ceil((EDGE - this.pointer.y) / 2)
    if (this.pointer.y > height - EDGE) return Math.ceil((this.pointer.y - height + EDGE) / 2)
    return 0
  }

  private readonly autoscroll = () => {
    const speed = this.edgeSpeed()
    if (!this.dragging || speed === 0) { this.scrolling = 0; return }
    const scroller = scrollContainer(this.image)
    if (scroller) scroller.scrollBy(0, speed)
    else window.scrollBy(0, speed)
    const caret = this.anchor && this.caretAt(this.pointer.x, this.pointer.y)
    if (this.anchor && caret) this.select(this.anchor, caret)
    this.scrolling = requestAnimationFrame(this.autoscroll)
  }

  private readonly pointerdown = (event: PointerEvent) => {
    this.lastPointerType = event.pointerType
    if (event.pointerType === "mouse") return
    this.press = { x: event.clientX, y: event.clientY, at: event.timeStamp }
    clearTimeout(this.longPress)
    this.longPress = window.setTimeout(() => {
      if (this.press) this.selectWordAt(this.press.x, this.press.y)
      this.press = null
    }, LONG_PRESS_MS)
  }

  private readonly pointermove = (event: PointerEvent) => {
    if (!this.press || event.pointerType === "mouse") return
    // Moving before the long press is a pan or a pinch, which the browser does.
    if (Math.hypot(event.clientX - this.press.x, event.clientY - this.press.y) > TAP_SLOP) this.cancelPress()
  }

  private readonly pointerup = (event: PointerEvent) => {
    if (!this.press || event.pointerType === "mouse") return
    this.selectWordAt(event.clientX, event.clientY)
    this.cancelPress()
  }

  private readonly cancelPress = () => {
    clearTimeout(this.longPress)
    this.press = null
  }

  /** A tap or long press: the word under the finger, or nothing when it misses the text. */
  private selectWordAt(x: number, y: number): void {
    const caret = this.caretAt(x, y, "start")
    const rect = caret?.node.parentElement?.getBoundingClientRect()
    const reach = rect ? rect.height : 0
    if (!caret || !rect || y < rect.top - reach || y > rect.bottom + reach || x < rect.left - reach * 2 || x > rect.right + reach * 2) {
      document.getSelection()?.removeAllRanges()
      return
    }
    this.select(caret, { node: caret.node, offset: caret.node.length })
  }

  /** A handle drag moves one end of the selection by whole words. */
  private dragHandle(event: PointerEvent, start: boolean): void {
    const range = this.range()
    if (!range || !(range.startContainer instanceof Text) || !(range.endContainer instanceof Text)) return
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    handle.setPointerCapture(event.pointerId)
    const fixed: Caret = start ? { node: range.endContainer, offset: range.endOffset } : { node: range.startContainer, offset: range.startOffset }
    const grabY = event.clientY - handle.getBoundingClientRect().top
    const move = (moved: PointerEvent) => {
      // Aim at the text above the handle, not under the finger.
      const caret = this.caretAt(moved.clientX, moved.clientY - grabY - 12, start ? "start" : "end")
      if (caret) this.select(fixed, caret)
    }
    const up = () => {
      handle.removeEventListener("pointermove", move)
      handle.removeEventListener("pointerup", up)
      handle.removeEventListener("pointercancel", up)
    }
    handle.addEventListener("pointermove", move)
    handle.addEventListener("pointerup", up)
    handle.addEventListener("pointercancel", up)
  }

  /** On touch the overlay is the menu target, not the image: no native image menu or selection. */
  private readonly contextmenu = (event: Event) => {
    if (this.lastPointerType !== "mouse") event.preventDefault()
  }

  /** The overlay sits at the document root, so wheel input over it reaches the image's scroller here. */
  private readonly wheel = (event: WheelEvent) => {
    if (event.ctrlKey) return
    const scroller = scrollContainer(this.image)
    if (!scroller) return
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? scroller.clientHeight : 1
    scroller.scrollBy(event.deltaX * unit, event.deltaY * unit)
    event.preventDefault()
  }

  /** Ctrl/Cmd+A selects the recognized text while nothing outside the overlay is selected. */
  private readonly keydown = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() !== "a" || !(event.ctrlKey || event.metaKey) || event.altKey) return
    const selection = document.getSelection()
    if (selection && !selection.isCollapsed && !this.range()) return
    event.preventDefault()
    this.selectAll()
  }
}

/** caretPositionFromPoint into the overlay's shadow root, where supported. */
function caretPosition(x: number, y: number, shadow: ShadowRoot): CaretPosition | null {
  const find = (document as Document & { caretPositionFromPoint?: (x: number, y: number, options?: { shadowRoots: ShadowRoot[] }) => CaretPosition | null })
    .caretPositionFromPoint
  return find ? find.call(document, x, y, { shadowRoots: [shadow] }) : null
}

/** The image's nearest scrolling ancestor below the document, or null. */
function scrollContainer(image: HTMLElement): HTMLElement | null {
  for (let node = image.parentElement; node && node !== document.body && node !== document.documentElement; node = node.parentElement) {
    const style = getComputedStyle(node)
    if (/(auto|scroll)/.test(style.overflowY + style.overflowX) &&
      (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth)) return node
  }
  return null
}
