export type ReadingUrlResult =
  | { ok: true; url: string }
  | { ok: false; error: string }

/** Normalize the URL-only mobile address field without treating text as search. */
export function normalizeReadingUrl(value: string): ReadingUrlResult {
  const draft = value.trim()
  if (!draft) return { ok: false, error: "Enter a web address." }
  const candidate = /^[a-z][a-z\d+.-]*:/i.test(draft)
    ? draft
    : `https://${draft}`
  try {
    const url = new URL(candidate)
    if ((url.protocol !== "http:" && url.protocol !== "https:") ||
        !url.hostname) {
      return { ok: false, error: "Enter an HTTP or HTTPS address." }
    }
    return { ok: true, url: url.href }
  } catch {
    return { ok: false, error: "That web address is not valid." }
  }
}
