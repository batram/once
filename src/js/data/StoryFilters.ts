import { Story } from "./Story"
import { ipcRenderer } from "electron"

export async function filter_stories(stories: Story[]): Promise<Story[]> {
  const filter_list = await ipcRenderer.invoke("inv_settings", "get_filterlist")
  return stories.map((story) => {
    return filter_run(filter_list, story)
  })
}

export async function filter_story(story: Story): Promise<Story> {
  const filter_list = await ipcRenderer.invoke("inv_settings", "get_filterlist")
  return filter_run(filter_list, story)
}

function filter_run(filter_list: string[], story: Story) {
  for (const pattern in filter_list) {
    if (
      story.href.includes(filter_list[pattern]) ||
      story.title
        .toLocaleLowerCase()
        .includes(filter_list[pattern].toLocaleLowerCase())
    ) {
      story.filter = filter_list[pattern]
      return story
    }
  }

  if (story.filter && !story.filter.startsWith("::")) {
    delete story.filter
  }

  return story
}
