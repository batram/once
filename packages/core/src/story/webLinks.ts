import type { StoryTag } from "./StoryTypes"

/**
 * True for an absolute http(s) address: the only kind of link a story, its
 * comments or its tags may carry, and the only kind a shell opens in a tab.
 * A feed chooses these strings, and a shell that opened whatever it was given
 * would open its own privileged pages (an extension page, a reader or history
 * page) for a feed that named one. A relative address fails too: the
 * extension tabs API resolves it against the extension's own origin.
 */
export function isWebUrl(value: unknown): boolean {
  if (typeof value !== "string") return false
  try {
    const { protocol } = new URL(value)
    return protocol === "http:" || protocol === "https:"
  } catch {
    return false
  }
}

/**
 * The link as collected when it is a web address, the same link resolved
 * against the source it came from when it is relative, and null otherwise.
 * An absolute link is kept as written: a story is identified by its address.
 */
export function webLink(value: unknown, sourceUrl: string): string | null {
  if (typeof value !== "string" || !value.trim()) return null
  if (isWebUrl(value)) return value
  try {
    const resolved = new URL(value, sourceUrl).href
    return isWebUrl(resolved) ? resolved : null
  } catch {
    return null
  }
}

interface CollectedLinks {
  href: string
  comment_url?: string
  tags?: StoryTag[]
  substories?: { comment_url: string; tags?: StoryTag[] }[]
}

function keepTagLinks(tags: StoryTag[] | undefined, sourceUrl: string): void {
  if (!Array.isArray(tags)) return
  for (const tag of tags) {
    if (!tag || tag.href === undefined) continue
    const href = webLink(tag.href, sourceUrl)
    if (href) tag.href = href
    else delete tag.href
  }
}

/**
 * The ingestion rule for what a collector returns. A story whose own link is
 * not a web address is dropped, since the link is what the story is; a
 * comments or tag link that is not one is removed and the story kept.
 */
export function keepWebLinks<T extends CollectedLinks>(stories: T[], sourceUrl: string): T[] {
  const kept: T[] = []
  for (const story of stories ?? []) {
    const href = story ? webLink(story.href, sourceUrl) : null
    if (!href) continue
    story.href = href
    if (story.comment_url !== undefined) story.comment_url = webLink(story.comment_url, sourceUrl) ?? ""
    keepTagLinks(story.tags, sourceUrl)
    for (const sub of Array.isArray(story.substories) ? story.substories : []) {
      sub.comment_url = webLink(sub.comment_url, sourceUrl) ?? ""
      keepTagLinks(sub.tags, sourceUrl)
    }
    kept.push(story)
  }
  return kept
}
