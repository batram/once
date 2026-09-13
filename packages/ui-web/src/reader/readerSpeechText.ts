export interface ReaderSpeechSegment {
  element: HTMLElement
  text: string
}

export function createReaderSpeechSegments(
  root: HTMLElement,
  maximum = 900
): ReaderSpeechSegment[] {
  return createReaderSpeechSegmentsWith(
    root,
    maximum,
    normalizeReaderSpeechText,
    splitReaderSpeechText
  )
}

// This function is inlined into the reader page through Function.toString(),
// so it must be self-contained: no module-level constants or helpers.
export function createReaderSpeechSegmentsWith(
  root: HTMLElement,
  maximum: number,
  normalize: typeof normalizeReaderSpeechText,
  split: typeof splitReaderSpeechText
): ReaderSpeechSegment[] {
  const blockSelector = "p,li,h2,h3,h4,h5,h6,blockquote,pre,figcaption,td,th"
  const blockLevelSelector = `${blockSelector},div,section,article,main,aside,header,footer,dd,dt,ul,ol,table,tbody,tr,hr,br,img,figure,nav,form,details,summary,script,style,noscript,template,svg,math`
  const isElement = (node: Node): node is HTMLElement => node.nodeType === 1

  // Pages such as paulgraham.com leave paragraphs as bare text between <p>
  // tags. Every run of inline siblings next to a block becomes its own
  // paragraph so it is read (and highlighted) like any other block. Any parent
  // of a block counts as a container, whatever its tag: sites wrap whole
  // articles in <span>, <font> or <center>.
  const containers = new Set<HTMLElement>([root])
  root.querySelectorAll<HTMLElement>(blockSelector).forEach((block) => {
    const parent = block.parentElement
    if (parent && !parent.matches(blockSelector)) containers.add(parent)
  })
  containers.forEach((container) => {
    const children = Array.from(container.childNodes)
    if (!children.some((node) => isElement(node) && node.matches(blockSelector))) return
    let run: ChildNode[] = []
    const flush = (): void => {
      if (run.some((node) => (node.textContent || "").trim())) {
        const paragraph = container.ownerDocument.createElement("p")
        container.insertBefore(paragraph, run[0])
        run.forEach((node) => paragraph.appendChild(node))
      }
      run = []
    }
    children.forEach((node) => {
      const isInline = node.nodeType === 3 ||
        (isElement(node) && !node.matches(blockLevelSelector))
      if (isInline) run.push(node)
      else flush()
    })
    flush()
  })

  // Long code is unreadable aloud; announce it and read only short snippets.
  // <pre> keeps its whitespace, so textContent is the faithful line source.
  const describeCode = (element: HTMLElement): string => {
    const raw = element.textContent || ""
    const lines = raw.split(/\r?\n/).filter((line) => line.trim())
    if (lines.length <= 3 && raw.length <= 160) return normalize(raw)
    return `Code block, ${lines.length} lines.`
  }

  let blocks = Array.from(root.querySelectorAll<HTMLElement>(blockSelector))
    .filter((element) => !element.querySelector(blockSelector))
  if (blocks.length === 0) blocks = [root]

  return blocks.flatMap((element) => {
    const text = element.matches("pre")
      ? describeCode(element)
      // innerText follows rendered reading order and supplies block/line spacing.
      : normalize(element.innerText || element.textContent || "")
    // Punctuation-only leftovers such as a lone "[" are not worth an utterance.
    return /[\p{L}\p{N}]/u.test(text)
      ? split(text, maximum).map((chunk) => ({ element, text: chunk }))
      : []
  })
}

export function normalizeReaderSpeechText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/\[\s*(?:\d{1,3}|[a-z]|note|citation needed)\s*\]/gi, " ")
    // Footnote bodies often start with a broken marker such as "3] text".
    .replace(/^\s*\[?\s*\d{1,3}\s*\]\s*/, "")
    .replace(/https?:\/\/\S+/gi, (url) => {
      try {
        return new URL(url.replace(/[),.;!?]+$/, "")).hostname.replace(/^www\./, "")
      } catch {
        return "link"
      }
    })
    .replace(/\b(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,})(?:\/[^\s)]*)+/gi, "$1")
    .replace(/[•·▪◦]+/g, ". ")
    .replace(/[—–]+/g, ", ")
    .replace(/…+/g, ". ")
    .replace(/&/g, " and ")
    .replace(/[@#*_~=<>|^`{}\\]+/g, " ")
    .replace(/([!?.,])\1+/g, "$1")
    .replace(/\s+/g, " ")
    .trim()
}

export function splitReaderSpeechText(value: string, maximum: number): string[] {
  if (value.length <= maximum) return [value]
  const sentences = value.match(/[^.!?]+(?:[.!?]+["')\]]*|$)\s*/g) || [value]
  const chunks: string[] = []
  let current = ""
  const append = (part: string): void => {
    if (current && current.length + part.length + 1 > maximum) {
      chunks.push(current)
      current = ""
    }
    current += `${current ? " " : ""}${part}`
  }
  sentences.forEach((sentence) => {
    const clean = sentence.trim()
    if (!clean) return
    if (clean.length > maximum) clean.split(" ").forEach(append)
    else append(clean)
  })
  if (current) chunks.push(current)
  return chunks
}
