import { sameDiscussion } from "./storyPage"
import { StoryTag, SubStory } from "./StoryTypes"
import { storyTimestamp } from "./storyTime"

interface Associations { type: string; comment_url: string; timestamp: string | number | Date; tags: StoryTag[]; substories: SubStory[] }

/** A renamed label/icon at the same source is not a new association. */
function tagKey(tag: StoryTag): string { return JSON.stringify([tag.class, tag.href || tag.text]) }

export function mergeStoryTags(current: StoryTag[], incoming: StoryTag[]): StoryTag[] {
  const keys = new Set(current.map(tagKey))
  const added = incoming.filter(tag => {
    const key = tagKey(tag)
    if (keys.has(key)) return false
    keys.add(key)
    return true
  }).sort((a, b) => tagKey(a).localeCompare(tagKey(b)))
  return [...current, ...added]
}

/** Keep established metadata, but retain new discussions and the tags belonging to each. */
export function mergeStoryAssociations(current: Associations, incoming: Associations): Pick<Associations, "tags" | "substories"> {
  let tags = [...current.tags]
  const substories = current.substories.map(sub => ({ ...sub, tags: sub.tags ? [...sub.tags] : undefined }))
  for (const candidate of [incoming, ...incoming.substories]) {
    const samePrimary = candidate.comment_url === current.comment_url || sameDiscussion(current.comment_url, candidate.comment_url)
    if (samePrimary) { tags = mergeStoryTags(tags, candidate.tags || []); continue }
    if (!candidate.comment_url) continue
    const existing = substories.find(sub => sameDiscussion(sub.comment_url, candidate.comment_url))
    if (existing) existing.tags = mergeStoryTags(existing.tags || [], candidate.tags || [])
    else substories.push({ type: candidate.type, comment_url: candidate.comment_url,
      timestamp: storyTimestamp(candidate.timestamp), tags: mergeStoryTags([], candidate.tags || []) })
  }
  return { tags, substories }
}
