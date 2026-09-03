// The projection of a story that add-ons see. Never the Story instance: a
// frozen bag of the fields a contribution may read, plus the collector's
// scalar extras under `fields`. DOM-free, so rows and tests share it.

/** The story fields any story-shaped object carries; `Story` satisfies it. */
export interface StoryLike {
  href: string
  title: string
  type: string
  comment_url?: string
  timestamp?: string | number | Date
  read_state?: "unread" | "read" | "skipped"
  stared?: boolean
  tags?: readonly { text?: string; class?: string }[]
  substories?: readonly { title?: string; comment_url?: string; type?: string }[]
  [extra: string]: unknown
}

export type StoryFieldValue = string | number | boolean

export interface StoryView {
  href: string
  redirectedHref: string
  commentUrl: string
  title: string
  type: string
  domain: string
  timestamp: string
  readState: "unread" | "read" | "skipped"
  stared: boolean
  tags: readonly string[]
  substories: readonly { title: string; commentUrl: string; type: string }[]
  fields: Readonly<Record<string, StoryFieldValue>>
}

const OWN_FIELDS = new Set([
  "href", "title", "type", "comment_url", "timestamp", "read_state", "stared",
  "tags", "substories", "filter", "sync_updated_at", "_attachments", "_rev", "_id"
])

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase()
  } catch {
    return ""
  }
}

function timestampText(value: StoryLike["timestamp"]): string {
  if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.toISOString() : ""
  if (typeof value === "number") return Number.isFinite(value) ? new Date(value).toISOString() : ""
  if (typeof value === "string") {
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toISOString() : ""
  }
  return ""
}

/**
 * Builds the view. `redirectedHref` is passed in because redirect rules are
 * a settings concern the caller already resolved for the row.
 */
export function projectStoryView(story: StoryLike, redirectedHref = story.href): StoryView {
  const fields: Record<string, StoryFieldValue> = {}
  for (const [name, value] of Object.entries(story)) {
    if (OWN_FIELDS.has(name) || name.startsWith("_")) continue
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      fields[name] = value
    }
  }
  return Object.freeze({
    href: story.href,
    redirectedHref,
    commentUrl: story.comment_url ?? "",
    title: story.title,
    type: story.type,
    domain: hostOf(redirectedHref),
    timestamp: timestampText(story.timestamp),
    readState: story.read_state ?? "unread",
    stared: story.stared === true,
    tags: Object.freeze((story.tags ?? []).map((tag) => tag.text ?? "").filter(Boolean)),
    substories: Object.freeze((story.substories ?? []).map((sub) => ({
      title: sub.title ?? "", commentUrl: sub.comment_url ?? "", type: sub.type ?? ""
    }))),
    fields: Object.freeze(fields)
  })
}
