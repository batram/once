/**
 * Validation for the two configurable collectors' selector configuration.
 *
 * Both describe the same shape — the difference is only what they select over,
 * a DOM tree or a JSON record — so they share this. It used to live in
 * `genyMatch` alone, which is why `jsonSelect` accepted whatever it was handed:
 * its configuration arrived as JSON embedded in a source line and went straight
 * to the selector engine.
 *
 * Everything not named here is rejected rather than ignored, so a typo in a
 * hand-written configuration is reported instead of silently doing nothing.
 */

export interface Selector {
  sel?: string
  all?: boolean
  component?: string
  processors?: string[]
  fallback?: string
}

export interface TagSelector {
  group_el?: Selector
  elements?: Record<string, Selector>
}

export interface SelectorConf {
  stories?: Selector
  link?: Selector
  title?: Selector
  timestamp?: Selector
  comment_href?: Selector
  tags?: TagSelector[]
}

const MAX_SELECTOR_LENGTH = 500
const MAX_TAG_SELECTORS = 10
const MAX_TAG_ELEMENTS = 20

export interface SelectorConfRules {
  /** Names this collector in every error, e.g. "geny_match config". */
  label: string
  /** Processor names this collector knows how to run. */
  processors: Record<string, unknown>
}

function sanitizeSelector(
  raw: unknown,
  path: string,
  rules: SelectorConfRules
): Selector {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${rules.label} ${path} must be an object`)
  }
  const source = raw as Record<string, unknown>
  const selector: Selector = {}
  for (const key of Object.keys(source)) {
    const value = source[key]
    if (key === "all") {
      if (typeof value !== "boolean") {
        throw new Error(`${rules.label} ${path}.all must be a boolean`)
      }
      selector.all = value
    } else if (key === "sel" || key === "component" || key === "fallback") {
      if (typeof value !== "string" || value.length > MAX_SELECTOR_LENGTH) {
        throw new Error(`${rules.label} ${path}.${key} must be a short string`)
      }
      selector[key] = value
    } else if (key === "processors") {
      if (
        !Array.isArray(value) ||
        value.some((name) => typeof name !== "string" || !rules.processors[name])
      ) {
        throw new Error(`${rules.label} ${path}.processors must name known processors`)
      }
      selector.processors = value as string[]
    } else {
      throw new Error(`${rules.label} ${path}.${key} is not a known selector field`)
    }
  }
  return selector
}

function sanitizeTagSelector(
  raw: unknown,
  path: string,
  rules: SelectorConfRules
): TagSelector {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${rules.label} ${path} must be an object`)
  }
  const source = raw as Record<string, unknown>
  const tag: TagSelector = {}
  for (const key of Object.keys(source)) {
    if (key === "group_el") {
      tag.group_el = sanitizeSelector(source[key], `${path}.group_el`, rules)
    } else if (key === "elements") {
      const elements = source[key]
      if (
        typeof elements !== "object" ||
        elements === null ||
        Array.isArray(elements) ||
        Object.keys(elements).length > MAX_TAG_ELEMENTS
      ) {
        throw new Error(`${rules.label} ${path}.elements must be a small object`)
      }
      tag.elements = {}
      for (const name of Object.keys(elements)) {
        tag.elements[name] = sanitizeSelector(
          (elements as Record<string, unknown>)[name],
          `${path}.elements.${name}`,
          rules
        )
      }
    } else {
      throw new Error(`${rules.label} ${path}.${key} is not a known tag field`)
    }
  }
  return tag
}

/**
 * Validates untrusted selector configuration — from the in-page picker, an
 * imported record or picker result — and returns a copy containing
 * only known fields.
 */
export function sanitizeSelectorConf(
  raw: unknown,
  rules: SelectorConfRules
): SelectorConf {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error(`${rules.label} must be an object`)
  }
  const source = raw as Record<string, unknown>
  const conf: SelectorConf = {}
  for (const key of Object.keys(source)) {
    if (
      key === "stories" ||
      key === "link" ||
      key === "title" ||
      key === "timestamp" ||
      key === "comment_href"
    ) {
      conf[key] = sanitizeSelector(source[key], key, rules)
    } else if (key === "tags") {
      const tags = source[key]
      if (!Array.isArray(tags) || tags.length > MAX_TAG_SELECTORS) {
        throw new Error(`${rules.label} tags must be a small array`)
      }
      conf.tags = tags.map((tag, index) =>
        sanitizeTagSelector(tag, `tags[${index}]`, rules)
      )
    } else {
      throw new Error(`${rules.label} ${key} is not a known field`)
    }
  }
  if (!conf.stories || !conf.link || !conf.title) {
    throw new Error(`${rules.label} is missing stories, link, or title`)
  }
  return conf
}
