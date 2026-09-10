import { AddonConversationSurface, StoryListItem, requestReading } from "@once/ui-web"

/**
 * The reading panel already mirrors an open tray over the story's page, so
 * continuing a conversation there is opening that story for reading.
 */
export const mobileAddonConversations: AddonConversationSurface = {
  label: "Continue in reading view",
  open(handle) {
    const href = handle.snapshot().story.href
    const row = Array.from(document.querySelectorAll<StoryListItem>("story-item")).find(item => item.story.href === href)
    if (row) requestReading(row.story, "browser")
  }
}
