import { Story } from "@once/core"
import { OnceSettings } from "@once/core"
import {
  applyStoryFilter,
  applyStoryFilters
} from "@once/core/story/filterStories"

export async function filter_stories(stories: Story[]): Promise<Story[]> {
  const filter_list = await OnceSettings.instance.get_filterlist()
  return applyStoryFilters(filter_list, stories)
}

export async function filter_story(story: Story): Promise<Story> {
  const filter_list = await OnceSettings.instance.get_filterlist()
  return applyStoryFilter(filter_list, story)
}
