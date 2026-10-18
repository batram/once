import { applyStoryFilter, Story } from "@once/core"

/** Derived rules change a value, not a user-edit clock on every evaluating device. */
export async function refilterStory(
  story: Story,
  filters: string[],
  save: (snapshot: Story) => Promise<unknown>,
  changed: (value: string, previous: string) => void
): Promise<void> {
  const previous = story.filter
  applyStoryFilter(filters, story)
  story.filter ||= ""
  if (story.filter === (previous || "")) return
  const previousUpdates = story.sync_updated_at
  // Zero explicitly marks derived state, so stale windows cannot revive an old clock.
  story.sync_updated_at = { ...previousUpdates, filter: 0 }
  const snapshot = Story.from_obj(story.to_obj())
  try { await save(snapshot) }
  catch (error) {
    if (story.filter === snapshot.filter) { story.filter = previous; story.sync_updated_at = previousUpdates }
    throw error
  }
  changed(story.filter, previous)
}
