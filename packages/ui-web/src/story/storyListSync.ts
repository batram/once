import { OnceClient, StoryChangeDetail } from "@once/app"
import { Story } from "@once/core"

export interface StoryListSyncTarget {
  addStories(stories: Story[], bucket: string, replace: boolean): void
  updateStory(change: StoryChangeDetail): void
  removeStory(href: string): void
  settingsChanged(section: string): void
  redirectsChanged(): void
}

export function connectStoryListSync(
  client: OnceClient,
  target: StoryListSyncTarget
): () => void {
  const unsubscribers = [
    client.subscribe("storyChanged", (details) => {
      if (details.story && !(details.story instanceof Story)) {
        details.story = Story.from_obj(
          details.story as unknown as Record<string, unknown>
        )
      }
      target.updateStory(details)
    }),
    client.subscribe("storiesChanged", ({ stories, bucket, replace }) => {
      target.addStories(stories, bucket, replace ?? false)
    }),
    client.subscribe("storyRemoved", ({ href }) => {
      target.removeStory(href)
    }),
    client.subscribe("settingsChanged", ({ section }) => {
      target.settingsChanged(section)
    }),
    client.subscribe("redirectsChanged", () => {
      target.redirectsChanged()
    })
  ]

  // Subscribe first, then replay the synchronous working-set snapshot. A
  // story arriving on either side of this handoff is observed at least once;
  // StoryList's href deduplication makes repeated delivery harmless.
  target.addStories(client.getStorySnapshot(), "stories", false)

  return () => unsubscribers.forEach((unsubscribe) => unsubscribe())
}
