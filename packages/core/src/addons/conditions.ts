// The `when` clause of a contribution: which stories it applies to. Every
// test is evaluated by Once against the story view, never by an add-on, so a
// row renders without waiting on anything.

import { StoryView } from "./storyView"

export interface AddonCondition {
  /** Story `type` badges, any of. */
  type?: readonly string[]
  /** Host of the redirected URL: exact, or `*.example.org` for subdomains too. */
  domain?: readonly string[]
  notDomain?: readonly string[]
  /** URL schemes of the redirected URL, without the colon. */
  scheme?: readonly string[]
  /** The story carries at least one of these tag texts. */
  tag?: readonly string[]
  readState?: readonly ("unread" | "read" | "skipped")[]
  stared?: boolean
  hasComments?: boolean
  /** Collector extras that must equal these values. */
  field?: Readonly<Record<string, string | number | boolean>>
}

export const CONDITION_KEYS: readonly (keyof AddonCondition)[] = Object.freeze([
  "type", "domain", "notDomain", "scheme", "tag", "readState", "stared", "hasComments", "field"
])

function domainMatches(pattern: string, host: string): boolean {
  const wanted = pattern.toLowerCase()
  if (wanted.startsWith("*.")) {
    const bare = wanted.slice(2)
    return host === bare || host.endsWith(`.${bare}`)
  }
  return host === wanted
}

function schemeOf(url: string): string {
  const separator = url.indexOf(":")
  return separator < 0 ? "" : url.slice(0, separator).toLowerCase()
}

/** True when every clause present in `when` holds; an empty clause matches all. */
export function storyMatchesCondition(when: AddonCondition | undefined, view: StoryView): boolean {
  if (!when) return true
  if (when.type && !when.type.includes(view.type)) return false
  if (when.domain && !when.domain.some((pattern) => domainMatches(pattern, view.domain))) return false
  if (when.notDomain && when.notDomain.some((pattern) => domainMatches(pattern, view.domain))) return false
  if (when.scheme && !when.scheme.map((s) => s.toLowerCase()).includes(schemeOf(view.redirectedHref))) {
    return false
  }
  if (when.tag && !when.tag.some((tag) => view.tags.includes(tag))) return false
  if (when.readState && !when.readState.includes(view.readState)) return false
  if (when.stared !== undefined && when.stared !== view.stared) return false
  if (when.hasComments !== undefined && when.hasComments !== (view.commentUrl !== "")) return false
  if (when.field) {
    for (const [name, value] of Object.entries(when.field)) {
      if (view.fields[name] !== value) return false
    }
  }
  return true
}
