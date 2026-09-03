// Templates in declarative contributions: `{href}` and friends substituted
// from the story view. In URL position every value is percent-encoded, so an
// add-on cannot smuggle a second query parameter through a title.

import { StoryView } from "./storyView"

const PLACEHOLDER = /\{([a-zA-Z_][a-zA-Z0-9_]*(?:\.[a-zA-Z_][a-zA-Z0-9_-]*)?)\}/g

const SIMPLE_KEYS: readonly (keyof StoryView)[] = Object.freeze([
  "href", "redirectedHref", "commentUrl", "title", "type", "domain", "timestamp", "readState"
])

/** Returns the placeholder names a template refers to; `fields.x` stays dotted. */
export function templatePlaceholders(template: string): string[] {
  return [...template.matchAll(PLACEHOLDER)].map((match) => match[1])
}

/** A placeholder the view can answer, or a `fields.*` lookup. */
export function isKnownPlaceholder(name: string): boolean {
  if (name.startsWith("fields.")) return name.length > "fields.".length
  return (SIMPLE_KEYS as readonly string[]).includes(name)
}

function valueOf(name: string, view: StoryView): string {
  if (name.startsWith("fields.")) {
    const value = view.fields[name.slice("fields.".length)]
    return value === undefined ? "" : String(value)
  }
  if ((SIMPLE_KEYS as readonly string[]).includes(name)) {
    return String(view[name as keyof StoryView])
  }
  return ""
}

/**
 * Substitutes placeholders. `mode: "url"` encodes each value for a URL
 * component and checks the result is http(s); it throws otherwise, so a bad
 * template surfaces as a diagnostic rather than a navigation to nowhere.
 */
export function renderAddonTemplate(
  template: string,
  view: StoryView,
  mode: "url" | "text"
): string {
  const rendered = template.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = valueOf(name, view)
    return mode === "url" ? encodeURIComponent(value) : value
  })
  if (mode === "url") {
    let parsed: URL
    try {
      parsed = new URL(rendered)
    } catch {
      throw new Error(`Template did not produce a URL: ${template}`)
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error(`Template URL must be http(s): ${template}`)
    }
    return parsed.toString()
  }
  return rendered
}
