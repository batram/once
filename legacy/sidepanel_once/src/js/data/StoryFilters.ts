import { Story } from "./Story"
import { OnceSettings } from "../OnceSettings"

export async function filter_stories(stories: Story[]): Promise<Story[]> {
  const filter_list = await OnceSettings.instance.get_filterlist()
  return stories.map((story) => {
    return filter_run(filter_list, story)
  })
}

export async function filter_story(story: Story): Promise<Story> {
  const filter_list = await OnceSettings.instance.get_filterlist()
  return filter_run(filter_list, story)
}

function filter_run(filter_list: string[], story: Story) {
  for (const pattern in filter_list) {
    const match_strings = []
    match_strings.push(story.href)
    match_strings.push(story.title)
    if (story.tags) {
      match_strings.push(story.tags.map((x) => x.text).join(" "))
    }
    if (story.substories) {
      story.substories.forEach((sub) => {
        if (sub.tags) {
          match_strings.push(sub.tags.map((x) => x.text).join(" "))
        }
      })
    }
    const match = match_strings.join(" ").toLocaleLowerCase()

    if (match.includes(filter_list[pattern].toLocaleLowerCase())) {
      story.filter = filter_list[pattern]
      return story
    }
  }

  if (story.filter && !story.filter.startsWith("::")) {
    delete story.filter
  }

  return story
}
