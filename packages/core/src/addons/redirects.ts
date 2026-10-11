// Redirects an add-on contributes: a rule shaped like a user's redirect, whose
// replacement the add-on's script may keep current (a mirror that moves, an
// instance picked by health). They show beside the user's own rules and each
// can be switched off there.

// The manifest's own id and label rules, restated so the manifest can import this file.
const ADDON_LIMITS = { idPattern: /^[a-z0-9][a-z0-9-]{1,38}[a-z0-9]$/, label: 60 }

export interface AddonRedirect {
  id: string
  title: string
  /** A JavaScript regular expression, matched against the whole URL. */
  match: string
  /** The replacement, with `$1` backreferences; with `dynamic`, only the fallback until the script names one. */
  replace?: string
  /** The script supplies the replacement through `once.redirects`. */
  dynamic: boolean
  enabledByDefault: boolean
  /** How old a replacement the script supplied may get before it is asked again. */
  refreshMinutes: number
}

export const ADDON_REDIRECT_LIMITS = Object.freeze({
  count: 4,
  pattern: 2048,
  defaultRefreshMinutes: 360
})

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Whether a replacement may stand in for a URL: http(s), with a fixed host before any backreference. */
export function isRedirectReplacement(value: unknown): value is string {
  return typeof value === "string" && value.length <= ADDON_REDIRECT_LIMITS.pattern &&
    /^https?:\/\/[^/$]+\//i.test(value)
}

/**
 * The fixed text a replacement puts in front of every URL it produces: what
 * says that a page that failed to load came from this rule, and what is
 * swapped when the rule moves elsewhere.
 */
export function redirectReplacementPrefix(replacement: string): string {
  const dollar = replacement.indexOf("$")
  return dollar === -1 ? replacement : replacement.slice(0, dollar)
}

/** The same page under a new replacement, when the URL came from the old one. */
export function moveRedirectedUrl(url: string, previous: string, next: string): string | null {
  const from = redirectReplacementPrefix(previous)
  const to = redirectReplacementPrefix(next)
  if (!url.startsWith(from) || from === to) return null
  return to + url.slice(from.length)
}

/** The `redirects` of a manifest; throws naming the first problem. */
export function readAddonRedirects(value: unknown): AddonRedirect[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > ADDON_REDIRECT_LIMITS.count) {
    throw new Error(`redirects must be a list of at most ${ADDON_REDIRECT_LIMITS.count} rules`)
  }
  const seen = new Set<string>()
  return value.map((raw, index) => {
    const path = `redirects[${index}]`
    if (!isRecord(raw)) throw new Error(`${path} must be an object`)
    if (typeof raw.id !== "string" || !ADDON_LIMITS.idPattern.test(raw.id) || seen.has(raw.id)) {
      throw new Error(`${path}.id must be a unique simple identifier`)
    }
    seen.add(raw.id)
    if (typeof raw.title !== "string" || !raw.title.trim() || raw.title.length > ADDON_LIMITS.label) {
      throw new Error(`${path}.title must be a short label`)
    }
    if (typeof raw.match !== "string" || !raw.match || raw.match.length > ADDON_REDIRECT_LIMITS.pattern) {
      throw new Error(`${path}.match must be a regular expression`)
    }
    try { new RegExp(raw.match) } catch { throw new Error(`${path}.match is not a valid regular expression`) }
    const dynamic = raw.dynamic === true
    if (raw.replace === undefined ? !dynamic : !isRedirectReplacement(raw.replace)) {
      throw new Error(`${path}.replace must be an http(s) URL with a fixed host` + (dynamic ? "" : "; it is required unless dynamic"))
    }
    const refresh = raw.refreshMinutes
    if (refresh !== undefined && (typeof refresh !== "number" || refresh < 15 || refresh > 60 * 24 * 7)) {
      throw new Error(`${path}.refreshMinutes must be between 15 minutes and a week`)
    }
    return {
      id: raw.id, title: raw.title.trim(), match: raw.match,
      ...(typeof raw.replace === "string" ? { replace: raw.replace } : {}),
      dynamic, enabledByDefault: raw.enabledByDefault !== false,
      refreshMinutes: typeof refresh === "number" ? Math.round(refresh) : ADDON_REDIRECT_LIMITS.defaultRefreshMinutes
    }
  })
}

/** The user's on/off choices, by redirect id; anything malformed is dropped. */
export function readRedirectToggles(value: unknown): Record<string, boolean> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
    .filter((entry): entry is [string, boolean] => ADDON_LIMITS.idPattern.test(entry[0]) && typeof entry[1] === "boolean")
    .slice(0, ADDON_REDIRECT_LIMITS.count)
  return entries.length ? Object.fromEntries(entries) : undefined
}
