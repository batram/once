// Once's synced filter lists for Tier 2 (no DevTools, so no uBlock Origin):
// the portable subset the GeckoView bridge extension applies
// (apps/mobile/extensions/once-surface/filterRules.js, which stays a plain
// extension script there), ported here and turned into
// `declarativeNetRequest` rules for Java's evaluator plus generic cosmetic
// selectors. The subset is deliberate: a constraint is never silently
// discarded, so a rule with options, a regex, a domain-scoped cosmetic or a
// procedural selector is skipped, and a list carrying exceptions this
// subset cannot honour gives up its block rules (or its cosmetics) rather
// than over-block. tests/unit/mobile/lite-tier2.test.js keeps the two
// parsers in agreement.

import { DnrRule, parseDnrRule } from "@once/core"

export interface ParsedFilterList {
  /** `urlFilter` sources of the block rules. */
  blocked: string[]
  /** `urlFilter` sources of the `@@` exceptions. */
  allowed: string[]
  /** Generic `##selector` cosmetics. */
  selectors: string[]
  skipped: number
}

/**
 * A generic selector the subset takes: no procedural or combinator syntax
 * (`+`, `:`), and nothing that could leave its rule in the style sheet
 * (`{`, `}`, `;`, `@`, a backslash or a comment) or swallow the rules after
 * it (an unclosed bracket, parenthesis or quote). Same as `onceFilterRules`.
 */
export function safeSelector(selector: string): boolean {
  if (!selector.trim() || /[+:{};@\\]|\/\*|\*\//.test(selector)) return false
  const closing: string[] = []
  let quote = ""
  for (const char of selector) {
    if (quote) { if (char === quote) quote = ""; continue }
    if (char === "\"" || char === "'") quote = char
    else if (char === "[") closing.push("]")
    else if (char === "(") closing.push(")")
    else if (char === "]" || char === ")") { if (closing.pop() !== char) return false }
  }
  return !quote && closing.length === 0
}

/** Same acceptance as `onceFilterRules.parse`. */
export function parseFilterList(text: string): ParsedFilterList {
  const blocked: string[] = []
  const allowed: string[] = []
  const selectors: string[] = []
  let skipped = 0
  let unsafeException = false
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith("!") || line.startsWith("[")) continue
    if (line.startsWith("##") && safeSelector(line.slice(2))) {
      selectors.push(line.slice(2))
      continue
    }
    const exception = line.startsWith("@@")
    const value = exception ? line.slice(2) : line
    if (!value || value.includes("$") || value.includes("#") || value.startsWith("/")) {
      skipped++
      if (exception || value.includes("$badfilter")) unsafeException = true
      continue
    }
    ;(exception ? allowed : blocked).push(value)
  }
  const cosmeticException = text.includes("#@#")
  return {
    blocked: unsafeException ? [] : blocked,
    allowed,
    selectors: cosmeticException ? [] : selectors,
    skipped
  }
}

export interface FilterListRules {
  rules: DnrRule[]
  selectors: string[]
  /** Lines the subset or the DNR syntax refused. */
  skipped: number
}

/**
 * The lists as DNR rules: blocks at priority 1 and exceptions at priority 1
 * (allow beats block at equal priority). The DNR default applies: a rule
 * without resource types never matches a top-level document.
 */
export function filterListRules(lists: readonly ParsedFilterList[], firstId = 1): FilterListRules {
  const rules: DnrRule[] = []
  const selectors: string[] = []
  const seenSelectors = new Set<string>()
  let skipped = 0
  let id = firstId
  const add = (urlFilter: string, type: "block" | "allow") => {
    try {
      rules.push(parseDnrRule({ id, priority: 1, action: { type }, condition: { urlFilter } }, "filter list rule"))
      id += 1
    } catch {
      skipped += 1
    }
  }
  for (const list of lists) {
    skipped += list.skipped
    for (const value of list.blocked) add(value, "block")
    for (const value of list.allowed) add(value, "allow")
    for (const selector of list.selectors) {
      if (seenSelectors.has(selector)) continue
      seenSelectors.add(selector)
      selectors.push(selector)
    }
  }
  return { rules, selectors, skipped }
}

/** One style sheet hiding the selectors; each selector its own rule so one bad selector drops alone. */
export function cosmeticCss(selectors: readonly string[]): string {
  return selectors.map((selector) => `${selector} { display: none !important; }`).join("\n")
}
