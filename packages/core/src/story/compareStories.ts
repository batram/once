import { SortableStory } from "./StoryTypes"
import { storyDisplayTime } from "./storyTime"

export function compareStories(a: SortableStory, b: SortableStory): 1 | 0 | -1 {
  const aRead = a.read_state != "unread"
  const bRead = b.read_state != "unread"

  if (aRead && !bRead) {
    return 1
  } else if (!aRead && bRead) {
    return -1
  } else if ((aRead && bRead) || (!aRead && !bRead)) {
    if (storyDisplayTime(a) > storyDisplayTime(b)) return -1
    if (storyDisplayTime(a) < storyDisplayTime(b)) return 1
    return 0
  }

  if (a.timestamp > b.timestamp) return -1
  if (a.timestamp < b.timestamp) return 1
  return 0
}
