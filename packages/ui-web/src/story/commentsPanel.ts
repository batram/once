// A story's comments in the Once panel, beside the page the reader is on,
// rather than in place of it. Offered next to the ordinary "open comments" on
// the desktop shells; mobile already reads comments in its own sheet. Like the
// add-on conversation panel, the panel and its menu button exist only while
// comments are shown there, and go away when it is closed.
import type { Story } from "@once/core"
import { getOnceClient } from "../client"
import { TemporaryPanel, barButton } from "../shell/temporaryPanel"

/** The `active_panel` name of the comments panel. */
export const COMMENTS_PANEL = "comments"

/** A page shown in the panel's body. */
export interface PanelPage {
  navigate(url: string): void
  dispose(): void
}

/** What a platform reports about the page it shows, when it can tell. */
export interface PanelPageEvents {
  /** The page went to `url`, which "open in a tab" then takes along. */
  navigated(url: string): void
  /** The page is gone (its process ended, say); the panel closes with it. */
  closed(): void
}

/**
 * How a platform shows a web page inside the panel: an iframe by default,
 * a native view laid over the body on Electron, whose pages share the tabs'
 * session.
 */
export interface PanelPageHost {
  mount(body: HTMLElement, url: string, events: PanelPageEvents): PanelPage
}

/**
 * An iframe. It may not navigate the panel itself (no top navigation), and
 * its new-window links open as ordinary tabs.
 */
const framePageHost: PanelPageHost = {
  mount(body, url) {
    const frame = document.createElement("iframe")
    frame.className = "comments_panel_frame"
    frame.dataset.testid = "comments-panel-frame"
    frame.setAttribute("sandbox", "allow-scripts allow-same-origin allow-forms allow-popups allow-popups-to-escape-sandbox")
    frame.referrerPolicy = "strict-origin-when-cross-origin"
    frame.src = url
    body.replaceChildren(frame)
    return {
      navigate: next => { frame.src = next },
      dispose: () => frame.remove()
    }
  }
}

let host: PanelPageHost = framePageHost

/** Replaces the iframe with the platform's own page surface. */
export function setPanelPageHost(next: PanelPageHost): void {
  host = next
}

/** Whether this shell offers comments in the panel at all. */
export function canOpenCommentsInPanel(): boolean {
  return document.body.dataset.platform !== "mobile"
}

let shown: { panel: TemporaryPanel; page: PanelPage; url: string } | null = null

function close(): void {
  if (!shown) return
  const { panel, page } = shown
  shown = null
  page.dispose()
  panel.remove()
}

/**
 * Shows a story's comments page (or `url`, another aggregator's) in the panel.
 * One page at a time: newer comments take the place of the last.
 */
export function openCommentsInPanel(story: Story, url = story.comment_url): void {
  if (!url || !/^https?:/i.test(url)) return
  void getOnceClient().persistStoryChange(url, "read_state", "read")
  if (shown) {
    shown.url = url
    shown.page.navigate(url)
  } else {
    const panel = TemporaryPanel.create(COMMENTS_PANEL, close)
    if (!panel) return
    panel.addBarButton(barButton("popout", "Open comments in a tab", () => {
      const current = shown?.url ?? url
      close()
      getOnceClient().openUrl(current, "blank")
    }))
    const state: { panel: TemporaryPanel; page: PanelPage; url: string } = { panel, url, page: { navigate() {}, dispose() {} } }
    shown = state
    state.page = host.mount(panel.body, url, {
      navigated: next => { state.url = next },
      closed: () => { if (shown === state) close() }
    })
  }
  // "Comments" does not fit the menu's width; the title bar and tooltip name the story.
  shown.panel.label("comments", "Thread", story.title || url)
  shown.panel.show()
}
