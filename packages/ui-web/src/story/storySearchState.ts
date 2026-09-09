import { Story } from "@once/core"

/**
 * A global search result arrives fresh from its collector, so it knows nothing
 * about what the user already did with that story. When a stored copy exists,
 * its read state, star and saved article carry over onto the result, so the
 * row shows "read" or "skipped" the way the main list would. The result keeps
 * its own title, tags and substories, which may be newer than the stored ones.
 */
export function adoptStoredStoryState(
  result: Story,
  stored: Story | null | undefined
): Story {
  if (!stored) return result
  result.read_state = stored.read_state
  result.stared = stored.stared
  if (stored.sync_updated_at) {
    result.sync_updated_at = stored.sync_updated_at
  }
  if (stored.stored_content) {
    result.stored_content = stored.stored_content
  }
  return result
}
