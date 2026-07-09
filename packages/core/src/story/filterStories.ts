import { FilterableStory } from "./StoryTypes"

export function applyStoryFilter<T extends FilterableStory>(
  filterList: string[],
  story: T
): T {
  for (const pattern in filterList) {
    const matchStrings = [story.href, story.title]

    if (story.tags) {
      matchStrings.push(story.tags.map((x) => x.text).join(" "))
    }

    if (story.substories) {
      story.substories.forEach((sub) => {
        if (sub.tags) {
          matchStrings.push(sub.tags.map((x) => x.text).join(" "))
        }
      })
    }

    const match = matchStrings.join(" ").toLocaleLowerCase()

    if (match.includes(filterList[pattern].toLocaleLowerCase())) {
      story.filter = filterList[pattern]
      return story
    }
  }

  if (story.filter && !story.filter.startsWith("::")) {
    delete story.filter
  }

  return story
}

export function applyStoryFilters<T extends FilterableStory>(
  filterList: string[],
  stories: T[]
): T[] {
  return stories.map((story) => applyStoryFilter(filterList, story))
}
