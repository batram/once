import { URLRedirect } from "@once/core"

export type RedirectTesterField =
  HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

export interface RedirectTester {
  element: HTMLElement
  corpus: HTMLElement
  refresh(): void
}

function compileRedirect(pattern: string): RegExp | null {
  if (!pattern.trim()) return null
  try {
    return new RegExp(pattern, "d")
  } catch {
    return null
  }
}

/**
 * Exact spans of the capture groups, from the `d` flag's match indices.
 * Searching the URL for each captured substring would highlight the wrong run
 * whenever the same text occurs earlier in the URL.
 */
function captureRanges(match: RegExpExecArray): Array<[number, number]> {
  const indices = (match as RegExpExecArray & {
    indices?: Array<[number, number] | undefined>
  }).indices
  if (!indices) return []
  return indices.slice(1)
    .filter((range): range is [number, number] =>
      range !== undefined && range[0] < range[1])
    .sort((left, right) => left[0] - right[0])
}

/**
 * Builds the live preview for one redirect rule. The preview deliberately uses
 * URLRedirect.apply_redirect, the same implementation as the loader.
 */
export function createRedirectTester(
  pattern: RedirectTesterField,
  replacement: RedirectTesterField,
  storyUrls: string[]
): RedirectTester {
  const element = document.createElement("section")
  element.className = "structured_redirect_tester"
  const testLabel = document.createElement("label")
  testLabel.className = "structured_form_field field"
  const testLabelName = document.createElement("span")
  testLabelName.className = "field_label"
  testLabelName.textContent = "Test a URL"
  const testInput = document.createElement("input")
  testInput.type = "url"
  testInput.className = "structured_redirect_test_input"
  testInput.placeholder = "https://example.com/2026/an-article"
  const seed = compileRedirect(pattern.value)
  testInput.value = seed
    ? [...storyUrls]
      .sort((left, right) => left.length - right.length)
      .find((url) => seed.test(url)) || ""
    : ""
  testLabel.append(testLabelName, testInput)
  const output = document.createElement("div")
  output.className = "structured_redirect_output"
  const corpus = document.createElement("p")
  corpus.className = "structured_redirect_corpus"

  const line = (className: string, text: string): HTMLElement => {
    const paragraph = document.createElement("p")
    paragraph.className = className
    paragraph.textContent = text
    return paragraph
  }
  const labelled = (name: string): HTMLElement => {
    const paragraph = document.createElement("p")
    const strong = document.createElement("strong")
    strong.textContent = name
    paragraph.append(strong, document.createTextNode(" "))
    return paragraph
  }
  const countMatches = (expression: RegExp | null): void => {
    const matched = expression
      ? storyUrls.filter((url) => expression.test(url)).length
      : 0
    corpus.textContent =
      `Matches ${matched} of ${storyUrls.length} loaded stories`
  }
  const render = () => {
    const url = testInput.value
    output.textContent = ""
    if (!pattern.value.trim()) {
      countMatches(null)
      output.append(line(
        "structured_redirect_no_match",
        "Enter a match expression"
      ))
      return
    }
    let expression: RegExp
    try {
      expression = new RegExp(pattern.value, "d")
    } catch (caught) {
      countMatches(null)
      const failed = labelled("Match")
      failed.classList.add("structured_redirect_parse_error")
      failed.append(document.createTextNode(caught instanceof Error
        ? caught.message
        : "Invalid regular expression"))
      output.append(failed, labelled("Result"))
      return
    }
    countMatches(expression)
    const match = expression.exec(url)
    if (!match) {
      output.append(line("structured_redirect_no_match", "No match"))
      return
    }
    const matchLine = labelled("Match")
    let cursor = 0
    for (const [start, end] of captureRanges(match)) {
      if (start < cursor) continue
      matchLine.append(document.createTextNode(url.slice(cursor, start)))
      const mark = document.createElement("mark")
      mark.textContent = url.slice(start, end)
      matchLine.append(mark)
      cursor = end
    }
    matchLine.append(document.createTextNode(url.slice(cursor)))
    const resultLine = labelled("Result")
    resultLine.append(document.createTextNode(
      `→ ${URLRedirect.apply_redirect(url, expression, replacement.value)}`
    ))
    output.append(matchLine, resultLine)
  }
  let timer: number | undefined
  const refresh = () => {
    window.clearTimeout(timer)
    timer = window.setTimeout(render, 120)
  }
  for (const source of [pattern, replacement, testInput]) {
    source.addEventListener("input", refresh)
  }
  element.append(testLabel, output)
  return { element, corpus, refresh }
}
