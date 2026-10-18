import { mergeStoryAssociations, Story } from "@once/core"

/** Merge source associations without refreshing parsed metadata; roll back failed saves. */
export async function mergeIngestionTags(
  stored: Story,
  incoming: Story,
  save: (story: Story) => Promise<Story>,
  changed: (story: Story, previousTags: Story["tags"], previousSubstories?: Story["substories"]) => void
): Promise<Story> {
  const associations = mergeStoryAssociations(stored, incoming)
  if (JSON.stringify(associations) === JSON.stringify({ tags: stored.tags, substories: stored.substories })) return stored
  const previousTags = stored.tags
  const previousSubstories = stored.substories
  stored.tags = associations.tags
  stored.substories = associations.substories
  const updatedTags = stored.tags
  changed(stored, previousTags, previousSubstories)
  try {
    return await save(stored)
  } catch (error) {
    if (stored.tags === updatedTags) {
      stored.tags = previousTags
      stored.substories = previousSubstories
      changed(stored, updatedTags, associations.substories)
    }
    throw error
  }
}
