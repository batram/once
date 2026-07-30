function escapeCssIdent(value: string): string {
  if (typeof CSS !== "undefined" && CSS.escape) return CSS.escape(value)
  return value.replace(/[^a-zA-Z0-9_-]/g, (match) => `\\${match}`)
}

export function safeQueryAll(root: Element, selector: string): Element[] {
  if (!selector.trim()) return []
  try {
    return Array.from(root.querySelectorAll(selector))
  } catch {
    return []
  }
}

export function cssSegment(element: Element): string {
  const tag = element.tagName.toLowerCase()
  const classes = Array.from(element.classList)
    .filter((name) => !/^\d/.test(name))
    .slice(0, 3)
    .map((name) => `.${escapeCssIdent(name)}`)
  return tag + classes.join("")
}

export function generalizeStorySelector(element: Element): string {
  const doc = element.ownerDocument
  if (!doc?.body) return cssSegment(element)
  let best: { selector: string; score: number } | null = null

  let candidate: Element | null = element
  for (let depth = 0; candidate && candidate !== doc.body && depth < 15; depth++) {
    let selector = cssSegment(candidate)
    const parent: Element | null = candidate.parentElement
    if (candidate.classList.length === 0 && parent && parent !== doc.body) {
      selector = `${cssSegment(parent)} > ${selector}`
    }
    const matches = safeQueryAll(doc.body, selector)
    const score = matches.filter((match) => match.querySelector("a[href]")).length
    if (score >= 2 && (!best || score >= best.score)) best = { selector, score }
    candidate = parent
  }
  return best ? best.selector : cssSegment(element)
}

function nthOfType(element: Element): number {
  let index = 1
  let sibling = element.previousElementSibling
  while (sibling) {
    if (sibling.tagName === element.tagName) index++
    sibling = sibling.previousElementSibling
  }
  return index
}

export function relativeFieldSelector(
  root: Element,
  element: Element
): string | null {
  if (element === root || !root.contains(element)) return null
  const short = cssSegment(element)
  if (safeQueryAll(root, short)[0] === element) return short

  const parts: string[] = []
  let current: Element = element
  while (current !== root) {
    const parent: Element | null = current.parentElement
    if (!parent) break
    let segment = cssSegment(current)
    const twins = Array.from(parent.children).filter(
      (child) => child.tagName === current.tagName
    )
    if (twins.length > 1) segment += `:nth-of-type(${nthOfType(current)})`
    parts.unshift(segment)
    const candidate = parts.join(" > ")
    if (safeQueryAll(root, candidate)[0] === element) return candidate
    current = parent
  }
  return parts.join(" > ")
}
