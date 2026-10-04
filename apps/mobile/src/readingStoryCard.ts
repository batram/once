// The one remembered choice for the current-story card: the Settings select
// shows it, and collapsing or expanding the card while reading overwrites it,
// so every later story opens the way the last one was left.
const STORY_CARD_STATE_KEY = "once:mobile-story-card-state"

export function storedStoryCardCollapsed(): boolean {
  try {
    return localStorage.getItem(STORY_CARD_STATE_KEY) === "collapsed"
  } catch { return false }
}

export function rememberStoryCardCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(STORY_CARD_STATE_KEY, collapsed ? "collapsed" : "expanded")
  } catch { /* private mode or quota: the choice lasts the session */ }
}

export function renderStoryTags(tags: Array<{
  class: string
  text: string
  href?: string
  icon?: string
}>): void {
  const container = document.querySelector("#reading_story_tags")
  if (!container) return
  container.replaceChildren()
  for (const tag of tags) {
    const element = document.createElement("span")
    element.classList.add("tag", `tag_${tag.class}`)
    element.textContent = tag.text
    if (tag.icon) {
      element.classList.add("tag--icon")
      element.style.setProperty("--tag-icon", `url(${tag.icon})`)
    }
    container.append(element)
  }
}

