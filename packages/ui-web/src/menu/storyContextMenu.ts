import { URLRedirect } from "@once/core"
import { StoryHistory } from "../story/StoryHistory"
import type { StoryListItem } from "../story/StoryListItem"
import { getOnceClient } from "../client"
import { findStoryAction, registeredStoryActions } from "./storyActionRegistry"

export type BuiltinStoryMenuActionId =
  | "open"
  | "open-comments"
  | "open-browser"
  | "open-new-tab"
  | "open-background-tab"
  | "open-new-window"
  | "open-external"
  | "open-original"
  | "open-reader"
  | "toggle-read"
  | "toggle-bookmark"
  | "filter"
  | "save-content"
  | "search-domain"
  | "copy-link"
  | "copy-original-link"
  | "undo"
  | "redo"
  | "purge"
  | "inspect"

/** A built-in id, or an add-on action's `addon:<addon>/<action>` id. */
export type StoryMenuActionId = BuiltinStoryMenuActionId | (string & Record<never, never>)

export type StoryMenuPlatform = "electron" | "firefox" | "chrome" | "mobile"

export const STORY_MENU_REQUEST = "story-menu-request"

/**
 * Raised by a story row when the user asks for its actions — the ⋮ button and
 * a long-press both raise it, so a platform installs one handler and both
 * gestures open the same menu at the same anchor.
 */
export class StoryMenuRequestEvent extends Event {
  constructor(
    readonly story: StoryListItem,
    readonly anchor: HTMLElement
  ) {
    super(STORY_MENU_REQUEST, { bubbles: true, composed: true })
  }
}

export interface StoryMenuItemDescriptor {
  id: StoryMenuActionId
  label: string
  group: "navigation" | "state" | "discovery" | "history" | "advanced"
  enabled: boolean
  visible: boolean
}

export interface StoryMenuContext {
  platform: StoryMenuPlatform
  buildChannel: "release" | "dev"
  story?: StoryListItem
}

const item = (
  id: StoryMenuActionId,
  label: string,
  group: StoryMenuItemDescriptor["group"],
  enabled = true,
  visible = true
): StoryMenuItemDescriptor => ({ id, label, group, enabled, visible })

export function describeStoryMenu(
  context: StoryMenuContext
): StoryMenuItemDescriptor[] {
  const story = context.story
  const history = StoryHistory.instance
  const items: StoryMenuItemDescriptor[] = []
  // Touch gets a short, single-column menu under the thumb: no tab targets to
  // choose between, and undo/redo belong to a keyboard, not a long-press.
  const touch = context.platform === "mobile"

  if (story) {
    const redirected = URLRedirect.redirect_url(story.story.href)
    items.push(
      item("open", "Open story", "navigation"),
      item(
        "open-comments",
        "Open comments",
        "navigation",
        true,
        Boolean(story.story.comment_url)
      ),
      item(
        "open-browser",
        "Open in browser",
        "navigation",
        true,
        touch
      ),
      item("open-new-tab", "Open in new tab", "navigation", true, !touch),
      item(
        "open-background-tab",
        "Open in background tab",
        "navigation",
        true,
        !touch
      ),
      item(
        "open-new-window",
        "Open in new Once window",
        "navigation",
        true,
        context.platform === "electron"
      ),
      item(
        "open-external",
        "Open in default browser",
        "navigation",
        true,
        context.platform === "electron"
      ),
      item(
        "open-original",
        "Open original URL",
        "navigation",
        true,
        !touch && redirected !== story.story.href
      ),
      item("open-reader", "Open in reader", "navigation"),
      item("toggle-read", story.readActionLabel(), "state"),
      item("toggle-bookmark", story.bookmarkActionLabel(), "state"),
      item("filter", story.filterActionLabel(), "state"),
      item("save-content", story.saveContentActionLabel(), "state"),
      item("search-domain", "Search this domain", "discovery"),
      item("copy-link", "Copy link address", "discovery"),
      item(
        "copy-original-link",
        "Copy original link address",
        "discovery",
        true,
        !touch && redirected !== story.story.href
      )
    )
  }

  // Add-on actions sit after the built-ins of their group's neighbours: the
  // renderers group by the `group` field, so order here is within-group only.
  if (story) {
    for (const action of registeredStoryActions()) {
      if (!action.surfaces.includes("menu")) continue
      items.push(item(action.id, action.label, action.group, true, action.appliesTo(story)))
    }
  }

  items.push(
    item("undo", "Undo", "history", history?.canUndo ?? false, !touch),
    item("redo", "Redo", "history", history?.canRedo ?? false, !touch)
  )

  if (story) {
    items.push(
      item(
        "purge",
        "Purge story",
        "advanced",
        true,
        context.buildChannel === "dev"
      ),
      item(
        "inspect",
        "Inspect",
        "advanced",
        true,
        context.platform === "electron"
      )
    )
  }
  return items
}

export async function executeStoryMenuAction(
  id: StoryMenuActionId,
  story?: StoryListItem
): Promise<void> {
  if (id === "undo") return StoryHistory.instance?.undo()
  if (id === "redo") return StoryHistory.instance?.redo()
  if (!story) return

  switch (id) {
    case "open":
      return story.openStory("_self")
    case "open-comments":
      return story.openComments()
    case "open-browser":
      return story.openStory("blank")
    case "open-new-tab":
      return story.openStory("blank")
    case "open-background-tab":
      return story.openStory("middle")
    case "open-original":
      return story.openOriginal()
    case "open-reader": {
      const { requestReading } = await import("../ReadingSession.js")
      if (requestReading(story.story, "reader")) {
        await getOnceClient().persistStoryChange(
          story.story.href,
          "read_state",
          "read"
        )
        return
      }
      const { ReaderView } = await import("../reader/ReaderView.js")
      await ReaderView.open(story.story.href)
      await getOnceClient().persistStoryChange(
        story.story.href,
        "read_state",
        "read"
      )
      return
    }
    case "toggle-read":
      return story.toggleReadState()
    case "toggle-bookmark":
      return story.toggleBookmark()
    case "filter":
      return story.showFilterAction()
    case "save-content": {
      const { saveStoryContentFromPage } = await import("../reader/storedContent.js")
      try {
        await saveStoryContentFromPage(getOnceClient(), story.story.href)
      } catch (error) {
        const { LoaderInsights } = await import("../shell/LoaderInsights.js")
        const detail = error instanceof Error ? error.message : String(error)
        LoaderInsights.showErrorMessage(
          `The article could not be saved for offline: ${detail}`,
          `Operation: story.content\nStory: ${story.story.href}\n\n${
            error instanceof Error ? error.stack || error.message : String(error)
          }`
        )
      }
      return
    }
    case "search-domain": {
      const Search = await import("../story/storySearch.js")
      Search.searchStories(`domain:${new URL(story.story.href).hostname}`)
      return
    }
    case "copy-link":
      await navigator.clipboard.writeText(URLRedirect.redirect_url(story.story.href))
      return
    case "copy-original-link":
      await navigator.clipboard.writeText(story.story.href)
      return
    case "purge":
      await story.confirmPurge()
      return
    default:
      // Add-on actions; an id nothing registered (an add-on missing on this
      // device, or a stale binding) does nothing.
      await findStoryAction(id)?.run(story)
      return
  }
}

export function storyFromTarget(target: EventTarget | null): StoryListItem | undefined {
  return (target as Element | null)?.closest<StoryListItem>("story-item") ?? undefined
}
