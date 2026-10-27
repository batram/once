import { applyStoryFilter, Story, URLRedirect } from "@once/core"
import { StoryStorePort } from "./types"
import { StoryWorkingSet } from "./StoryWorkingSet"

// Persisted filter text is a cached rule result. Recompute on entry without
// rewriting the archive, and mark it derived so legacy clocks cannot win.
export async function filterLoadedStories(stories: Story[], getFilters: () => Promise<string[]>): Promise<Story[]> {
  const filters = await getFilters()
  return stories.map(story => {
    const current = Story.from_obj(story.to_obj())
    applyStoryFilter(filters, current)
    current.filter ||= ""
    if (current.filter === (story.filter || "")) return story
    current.sync_updated_at = { ...current.sync_updated_at, filter: 0 }
    return current
  })
}

export async function loadWorkingStories(
  store: StoryStorePort, workingSet: StoryWorkingSet, prepare: (stories: Story[]) => Promise<Story[]>
): Promise<Story[]> {
  const [stored, starred] = await Promise.all([store.getStories(500), store.getStaredStories()])
  const current = await prepare(stored.concat(starred))
  current.forEach(story => workingSet.set(story.href, story, true))
  return workingSet.snapshot()
}

export async function findLoadedStory(
  url: string, store: StoryStorePort, workingSet: StoryWorkingSet,
  prepare: (stories: Story[]) => Promise<Story[]>, load: () => Promise<Story[]>
): Promise<Story | null> {
  const original = URLRedirect.original_url(url)
  const existing = workingSet.lookup(url) ?? workingSet.lookup(original)
  if (existing) return existing
  const stored = await store.getStory(original)
  if (stored) {
    const [current] = await prepare([stored])
    return workingSet.lookup(url) ?? workingSet.lookup(original) ?? workingSet.set(stored.href, current, true)
  }
  await load()
  return workingSet.lookup(url) ?? workingSet.lookup(URLRedirect.original_url(url))
}
