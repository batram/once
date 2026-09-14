import {
  isReaderFindRequest,
  locateMatches,
  readerFindResponse
} from "./readerFindProtocol"

/**
 * The frame half of reader find-in-page. Runs inside the sandboxed reader
 * document: walks its text once per query, highlights every match through the
 * CSS Custom Highlight API where the engine has it, and selects and scrolls
 * to the current one, which is visible everywhere.
 */
const HIGHLIGHT_ALL = "once-find"
const HIGHLIGHT_CURRENT = "once-find-current"
const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"])

interface MatchSet {
  query: string
  ranges: Range[]
  current: number
}

export function installReaderFind(target: Window = window): void {
  const doc = target.document
  let matches: MatchSet | null = null
  const highlights = highlightRegistry(target)
  if (highlights) installHighlightStyle(doc)

  const clear = (): void => {
    matches = null
    highlights?.registry.delete(HIGHLIGHT_ALL)
    highlights?.registry.delete(HIGHLIGHT_CURRENT)
    target.getSelection()?.removeAllRanges()
  }

  const select = (set: MatchSet): void => {
    const range = set.ranges[set.current]
    if (highlights) {
      highlights.registry.set(HIGHLIGHT_ALL, new highlights.Highlight(...set.ranges))
      highlights.registry.set(HIGHLIGHT_CURRENT, new highlights.Highlight(range))
    }
    const selection = target.getSelection()
    selection?.removeAllRanges()
    selection?.addRange(range)
    scrollTo(target, range)
  }

  const find = (query: string, forward: boolean): void => {
    if (matches?.query !== query) {
      const ranges = collectRanges(doc, query)
      matches = { query, ranges, current: forward ? 0 : ranges.length - 1 }
    } else if (matches.ranges.length) {
      const count = matches.ranges.length
      matches.current = (matches.current + (forward ? 1 : count - 1)) % count
    }
    if (matches.ranges.length) select(matches)
    else {
      clear()
      matches = { query, ranges: [], current: 0 }
    }
    target.parent.postMessage(readerFindResponse({
      query,
      current: matches.ranges.length ? matches.current + 1 : 0,
      total: matches.ranges.length
    }), "*")
  }

  target.addEventListener("message", (event) => {
    if (event.source !== target.parent || !isReaderFindRequest(event.data)) return
    if (event.data.type === "clear") clear()
    else find(event.data.query, event.data.forward)
  })
}

/** Ranges for every match, in document order. */
function collectRanges(doc: Document, query: string): Range[] {
  if (!query) return []
  const nodes: Text[] = []
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      const parent = node.parentElement
      if (!parent || SKIPPED_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT
      if (parent.closest("[hidden]")) return NodeFilter.FILTER_REJECT
      return NodeFilter.FILTER_ACCEPT
    }
  })
  let text = ""
  const starts: number[] = []
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nodes.push(node as Text)
    starts.push(text.length)
    text += (node as Text).data
  }
  return locateMatches(text, query).map((offset) => {
    const range = doc.createRange()
    const [startNode, startOffset] = locate(nodes, starts, offset)
    const [endNode, endOffset] = locate(nodes, starts, offset + query.length)
    range.setStart(startNode, startOffset)
    range.setEnd(endNode, endOffset)
    return range
  })
}

/** The text node holding a global offset, and the offset inside it. */
function locate(nodes: Text[], starts: number[], offset: number): [Text, number] {
  let index = starts.length - 1
  while (index > 0 && starts[index] > offset) index -= 1
  const node = nodes[index]
  return [node, Math.min(offset - starts[index], node.data.length)]
}

function scrollTo(target: Window, range: Range): void {
  const rect = range.getBoundingClientRect()
  const centre = rect.top + rect.height / 2 - target.innerHeight / 2
  if (rect.top < 0 || rect.bottom > target.innerHeight) {
    target.scrollBy({ top: centre, behavior: "auto" })
  }
}

interface HighlightApi {
  registry: Map<string, unknown>
  Highlight: new (...ranges: Range[]) => unknown
}

/** The CSS Custom Highlight API, or null on engines without it. */
function highlightRegistry(target: Window): HighlightApi | null {
  const scope = target as unknown as {
    CSS?: { highlights?: Map<string, unknown> }
    Highlight?: new (...ranges: Range[]) => unknown
  }
  const registry = scope.CSS?.highlights
  if (!registry || typeof scope.Highlight !== "function") return null
  return { registry, Highlight: scope.Highlight }
}

function installHighlightStyle(doc: Document): void {
  const style = doc.createElement("style")
  style.textContent =
    `::highlight(${HIGHLIGHT_ALL}) { background: rgb(255 213 0 / 45%); }` +
    `::highlight(${HIGHLIGHT_CURRENT}) { background: rgb(255 140 0 / 80%); color: black; }`
  doc.head.append(style)
}
