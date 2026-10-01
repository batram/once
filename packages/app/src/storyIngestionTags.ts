import { Story } from "@once/core"

/** Merge tags only for the same comment source, restoring them if persistence fails. */
export async function mergeIngestionTags(
  stored: Story,
  incoming: Story,
  save: (story: Story) => Promise<Story>,
  changed: (story: Story, previousTags: Story["tags"]) => void
): Promise<Story> {
  if (incoming.comment_url != stored.comment_url) return stored
  const existingTags = new Set(stored.tags.map((tag) => tag.text))
  const addedTags = incoming.tags.filter((tag) => {
    if (existingTags.has(tag.text)) return false
    existingTags.add(tag.text)
    return true
  })
  if (addedTags.length === 0) return stored

  const previousTags = [...stored.tags]
  stored.tags.push(...addedTags)
  const updatedTags = stored.tags
  changed(stored, previousTags)
  try {
    return await save(stored)
  } catch (error) {
    if (stored.tags === updatedTags) {
      stored.tags = previousTags
      changed(stored, updatedTags)
    }
    throw error
  }
}
