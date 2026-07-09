import { Story } from "@once/core"
import { OnceSettings } from "@once/core"
import {
  applyStoryFilter,
  applyStoryFilters
} from "@once/core/story/filterStories"

let filterListProvider: () => Promise<string[]> = async () => {
  return (OnceSettings.instance || new OnceSettings()).get_filterlist()
}

export function configureStoryFilters(
  provider: () => Promise<string[]>
): void {
  filterListProvider = provider
}

export async function filter_stories(stories: Story[]): Promise<Story[]> {
  const filter_list = await filterListProvider()
  return applyStoryFilters(filter_list, stories)
}

export async function filter_story(story: Story): Promise<Story> {
  const filter_list = await filterListProvider()
  return applyStoryFilter(filter_list, story)
}
