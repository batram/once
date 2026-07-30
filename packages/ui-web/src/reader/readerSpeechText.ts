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

export function createReaderSpeechSegmentsWith(
  root: HTMLElement,
  maximum: number,
  normalize: typeof normalizeReaderSpeechText,
  split: typeof splitReaderSpeechText
): ReaderSpeechSegment[] {
  const blockSelector = "p,li,h2,h3,h4,h5,h6,blockquote,pre,figcaption,td,th"
  let blocks = Array.from(root.querySelectorAll<HTMLElement>(blockSelector))
    .filter((element) => !element.querySelector(blockSelector))
  if (blocks.length === 0) blocks = [root]

  return blocks.flatMap((element) => {
    // innerText follows rendered reading order and supplies block/line spacing.
    const text = normalize(element.innerText || element.textContent || "")
    return text
      ? split(text, maximum).map((chunk) => ({ element, text: chunk }))
      : []
  })
}

export function normalizeReaderSpeechText(value: string): string {
  return value
    .normalize("NFKC")
    .replace(/[\u200B-\u200D\u2060\uFEFF]/g, "")
    .replace(/https?:\/\/\S+/gi, (url) => {
      try {
        return new URL(url.replace(/[),.;!?]+$/, "")).hostname.replace(/^www\./, "")
      } catch {
        return "link"
      }
    })
    .replace(/[•·▪◦]+/g, ". ")
    .replace(/[—–]+/g, ", ")
    .replace(/…+/g, ". ")
    .replace(/&/g, " and ")
    .replace(/[@#*_~=<>|^]+/g, " ")
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
