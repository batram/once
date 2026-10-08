import { AddonConversationSurface, StoryListItem, requestReading } from "@once/ui-web"

/**
 * The reading panel shows a tray above the story's page, so continuing a
 * conversation there is opening that story for reading. It gets a tab of its
 * own, the tray opens in that tab, and it leaves the list it came from.
 */
export const mobileAddonConversations: AddonConversationSurface = {
  label: "Continue in new tab",
  moves: true,
  open(handle) {
    const href = handle.snapshot().story.href
    const row = Array.from(document.querySelectorAll<StoryListItem>("story-item")).find(item => item.story.href === href)
    // The request selects the new tab before it returns, so the tray opens there.
    if (row && requestReading(row.story, "browser", undefined, "new-foreground")) handle.showOnPage()
  }
}
