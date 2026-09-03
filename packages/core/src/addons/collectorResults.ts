// What an add-on collector hands back: plain objects the host turns into
// stories after checking them. The add-on cannot choose the `type` badge (it
// is the collector's declared one), cannot exceed the caps, and cannot name
// anything but http(s) URLs.

import { Story } from "../story/Story"
import { StoryTag } from "../story/StoryTypes"

export const COLLECTOR_RESULT_LIMITS = Object.freeze({
  stories: 500,
  title: 500,
  tags: 20,
  tagText: 60,
  extras: 16,
  extraText: 500
})

export interface AddonStoryResult {
  type: string
  href: string
  title: string
  comment_url: string
  timestamp: string | number
  filter: string
  tags: StoryTag[]
  [extra: string]: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value) && value.length <= 4096
}

const OWN = new Set(["type", "href", "title", "comment_url", "timestamp", "filter", "tags", "substories",
  "read_state", "stared", "sync_updated_at", "_id", "_rev", "_attachments"])

function readTags(value: unknown): StoryTag[] {
  if (!Array.isArray(value)) return []
  const tags: StoryTag[] = []
  for (const entry of value.slice(0, COLLECTOR_RESULT_LIMITS.tags)) {
    if (!isRecord(entry) || typeof entry.text !== "string" || !entry.text.trim()) continue
    const tag: StoryTag = {
      class: typeof entry.class === "string" ? entry.class.slice(0, 40) : "category",
      text: entry.text.trim().slice(0, COLLECTOR_RESULT_LIMITS.tagText)
    }
    if (isHttpUrl(entry.href)) tag.href = entry.href
    tags.push(tag)
  }
  return tags
}

/**
 * Vets one collector answer. Entries that are not stories are dropped rather
 * than failing the whole list, since a feed with one odd item is still a feed;
 * a non-list answer is an error the source should show.
 */
export function readAddonStories(value: unknown, type: string): AddonStoryResult[] {
  if (!Array.isArray(value)) throw new Error("the collector did not return a list of stories")
  const stories: AddonStoryResult[] = []
  for (const entry of value.slice(0, COLLECTOR_RESULT_LIMITS.stories)) {
    if (!isRecord(entry) || !isHttpUrl(entry.href) || typeof entry.title !== "string" || !entry.title.trim()) continue
    const timestamp = typeof entry.timestamp === "number" || typeof entry.timestamp === "string"
      ? entry.timestamp
      : Date.now()
    const story: AddonStoryResult = {
      type,
      href: entry.href,
      title: entry.title.trim().slice(0, COLLECTOR_RESULT_LIMITS.title),
      comment_url: isHttpUrl(entry.comment_url) ? entry.comment_url : "",
      timestamp,
      filter: typeof entry.filter === "string" ? entry.filter.slice(0, 200) : "",
      tags: readTags(entry.tags)
    }
    try {
      Story.assertIngestible(story)
    } catch {
      continue
    }
    let extras = 0
    for (const [name, extra] of Object.entries(entry)) {
      if (OWN.has(name) || name.startsWith("_") || extras >= COLLECTOR_RESULT_LIMITS.extras) continue
      if (typeof extra === "number" || typeof extra === "boolean") story[name] = extra
      else if (typeof extra === "string") story[name] = extra.slice(0, COLLECTOR_RESULT_LIMITS.extraText)
      else continue
      extras += 1
    }
    stories.push(story)
  }
  return stories
}
