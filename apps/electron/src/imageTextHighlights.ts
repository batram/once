interface Band { left: number; right: number; top: number; bottom: number }

/** Paint selection once per line, independently of the selectable word nodes. */
export class ImageTextHighlights {
  private readonly svg = document.createElementNS("http://www.w3.org/2000/svg", "svg")
  private readonly path = document.createElementNS("http://www.w3.org/2000/svg", "path")
  private dirty = true
  private width = 0
  private height = 0
  private readonly changed = () => { this.dirty = true }

  constructor(private readonly shadow: ShadowRoot, private readonly words: HTMLElement) {
    this.svg.classList.add("highlights")
    this.svg.setAttribute("aria-hidden", "true")
    this.svg.append(this.path)
    document.addEventListener("selectionchange", this.changed)
  }

  attach(width: number, height: number): void {
    this.width = width
    this.height = height
    this.words.style.width = `${width}px`
    this.words.style.height = `${height}px`
    this.svg.setAttribute("viewBox", `0 0 ${width} ${height}`)
    this.words.prepend(this.svg)
    this.dirty = true
  }

  update(): void {
    if (!this.dirty || !this.width) return
    const bounds = this.words.getBoundingClientRect()
    // Keep the pending update until the image returns to the visible area.
    if (!bounds.width || !bounds.height) return
    this.dirty = false
    const range = selectionRange(this.shadow)
    const bands = range ? selectedBands(this.words, range) : []
    joinCloseLines(bands)
    const x = (value: number) => ((value - bounds.left) * this.width / bounds.width).toFixed(2)
    const y = (value: number) => ((value - bounds.top) * this.height / bounds.height).toFixed(2)
    // One filled SVG path means touching/overlapping bands never accumulate
    // opacity. Geometry is in image coordinates, so scrolling and resizing
    // use the same transform as the selectable text without repainting it.
    this.path.setAttribute("d", bands.map(band =>
      `M${x(band.left)} ${y(band.top)}H${x(band.right)}V${y(band.bottom)}H${x(band.left)}Z`
    ).join(""))
  }

  destroy(): void {
    document.removeEventListener("selectionchange", this.changed)
    this.svg.remove()
  }
}

function selectionRange(shadow: ShadowRoot): Range | null {
  const selection = window.getSelection()
  if (!selection || !selection.rangeCount) return null
  // getRangeAt can retarget user-created shadow selections to the host.
  const selected = selection.getComposedRanges({ shadowRoots: [shadow] })[0]
  if (!selected || selected.startContainer.getRootNode() !== shadow || selected.endContainer.getRootNode() !== shadow) return null
  if (selected.startContainer === selected.endContainer && selected.startOffset === selected.endOffset) return null
  const range = document.createRange()
  range.setStart(selected.startContainer, selected.startOffset)
  range.setEnd(selected.endContainer, selected.endOffset)
  return range
}

function selectedBands(container: HTMLElement, selection: Range): Band[] {
  const lines = new Map<string, HTMLElement[]>()
  for (const word of container.querySelectorAll<HTMLElement>(".word")) {
    const id = word.dataset.line ?? ""
    const line = lines.get(id) ?? []
    line.push(word)
    lines.set(id, line)
  }
  const bands: Band[] = []
  for (const line of lines.values()) {
    const boxes = line.map(word => word.getBoundingClientRect())
    const top = Math.min(...boxes.map(box => box.top))
    const bottom = Math.max(...boxes.map(box => box.bottom))
    const selected = line.flatMap(word => selectedWordRects(word, selection)).sort((a, b) => a.left - b.left)
    let band: Band | undefined
    for (const box of selected) {
      // Fill ordinary inter-word spaces, but preserve a substantial column
      // gutter or a list marker separated from its paragraph.
      if (band && box.left - band.right <= (bottom - top) * 2) {
        band.right = Math.max(band.right, box.right)
      } else {
        band = { left: box.left, right: box.right, top, bottom }
        bands.push(band)
      }
    }
  }
  return bands
}

function selectedWordRects(word: HTMLElement, selection: Range): DOMRect[] {
  const text = word.firstChild
  if (!(text instanceof Text) || !selection.intersectsNode(text)) return []
  const start = selection.startContainer === text ? selection.startOffset : 0
  const end = selection.endContainer === text ? selection.endOffset : text.length
  if (end <= start) return []
  const range = document.createRange()
  range.setStart(text, start)
  range.setEnd(text, end)
  return [...range.getClientRects()].filter(rect => rect.width > 0 && rect.height > 0)
}

/** Close tiny line seams within a paragraph without filling paragraph breaks. */
function joinCloseLines(bands: Band[]): void {
  bands.sort((a, b) => a.top - b.top || a.left - b.left)
  for (let i = 1; i < bands.length; i++) {
    const previous = bands[i - 1], next = bands[i]
    const height = Math.min(previous.bottom - previous.top, next.bottom - next.top)
    const gap = next.top - previous.bottom
    if (gap >= 0 && gap <= height * 0.18 && Math.min(previous.right, next.right) > Math.max(previous.left, next.left)) {
      previous.bottom = next.top = (previous.bottom + next.top) / 2
    }
  }
}
