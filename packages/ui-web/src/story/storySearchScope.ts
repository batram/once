export function searchableStoryElements<T extends Element = HTMLElement>(
  storyContainer: ParentNode
): NodeListOf<T> {
  return storyContainer.querySelectorAll<T>(".story")
}
