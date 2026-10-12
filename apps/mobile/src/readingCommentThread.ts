// Mobile's comments mode, where a collector can read the site's discussion:
// the thread drawn by Once over the reading content, swipeable and navigable,
// with the site's page (still loaded underneath by the native surface) one
// tap away. A thread that cannot be read leaves the page showing and says why.
import { CommentThreadView, commentsFailureNote, getOnceClient } from "@once/ui-web"
import { selectOnDoubleTap } from "./touchSelection"

export interface ReadingCommentThreadHost {
  /** The native page must hide while the thread covers it. */
  setCovered(open: boolean): void
  announce(message: string): void
}

export class ReadingCommentThread {
  private readonly element: HTMLElement
  private view: CommentThreadView | null = null
  private url = ""
  private generation = 0
  /** Comment pages the reader chose to see as pages. */
  private readonly asPage = new Set<string>()

  constructor(content: HTMLElement, private readonly host: ReadingCommentThreadHost) {
    this.element = document.createElement("div")
    this.element.className = "reading_comment_thread"
    this.element.dataset.testid = "reading-comment-thread"
    this.element.hidden = true
    content.append(this.element)
    // Words in an open comment's text, as on pages; links, headers and collapsed previews keep their taps.
    selectOnDoubleTap(this.element, target =>
      !!target.closest(".comment:not(.is-collapsed) > .comment_main > .comment_body") && !target.closest("a[href]"))
  }

  /** Whether the thread, rather than the page, is what comments mode shows. */
  get shown(): boolean {
    return !this.element.hidden
  }

  /** Follows the session: shows the thread in comments mode when it can be read. */
  sync(mode: string, url: string, visible: boolean): void {
    const wanted = visible && mode === "comments" && Boolean(url) &&
      !this.asPage.has(url) && canRead(url)
    if (!wanted) {
      this.hide()
      return
    }
    if (url === this.url && this.shown) return
    this.url = url
    void this.load(false)
  }

  /** The comments button in comments mode: thread to page and back. */
  toggle(url: string): boolean {
    if (!canRead(url)) return false
    if (this.shown) {
      this.asPage.add(url)
      this.hide()
    } else {
      this.asPage.delete(url)
      this.url = url
      void this.load(false)
    }
    return true
  }

  private async load(refresh: boolean): Promise<void> {
    const generation = ++this.generation
    const url = this.url
    this.show()
    if (!this.view) this.element.replaceChildren(status("Loading comments…"))
    try {
      const thread = await getOnceClient().loadComments(url, { refresh })
      if (generation !== this.generation) return
      this.view?.dispose()
      this.view = new CommentThreadView(thread, {
        openUrl: (href, target) => getOnceClient().openUrl(href, target === "middle" ? "blank" : "current"),
        reload: () => void this.load(true),
        togglePage: () => this.toggle(url),
        pageButton: true
      })
      this.element.replaceChildren(this.view.root)
      this.view.activate()
    } catch (error) {
      if (generation !== this.generation) return
      this.asPage.add(url)
      this.hide()
      this.host.announce(commentsFailureNote(error))
    }
  }

  private show(): void {
    if (this.shown) return
    this.element.hidden = false
    this.host.setCovered(true)
  }

  private hide(): void {
    this.generation++
    this.view?.dispose()
    this.view = null
    this.url = ""
    if (!this.shown) return
    this.element.hidden = true
    this.element.replaceChildren()
    this.host.setCovered(false)
  }
}

/** False too before a client exists (early start-up, tests of the reading shell). */
function canRead(url: string): boolean {
  try {
    return getOnceClient().canLoadComments(url)
  } catch {
    return false
  }
}

function status(text: string): HTMLElement {
  const element = document.createElement("p")
  element.className = "comment_thread_loading"
  element.setAttribute("role", "status")
  element.textContent = text
  return element
}
