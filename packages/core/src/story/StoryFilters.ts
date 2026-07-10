import { defaultFilterList } from "../settings/defaults"
import { Story } from "./Story"
import { applyStoryFilter, applyStoryFilters } from "./filterStories"

let filterListProvider: () => Promise<string[]> = async () => defaultFilterList

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
