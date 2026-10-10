// What the comments panel shows: the thread as Once reads it, when a collector
// knows the site, or the site's own comment page. The reader can switch between
// the two, and a thread that cannot be read falls back to the page with a note
// saying why.
import type { CommentThread } from "@once/core"
import { getOnceClient } from "../client"
import { CommentThreadView } from "./CommentThreadView"

export type CommentsMode = "thread" | "page"

/** The site's page in the panel body (see PanelPageHost in commentsPanel). */
export interface CommentsPage {
  navigate(url: string): void
  dispose(): void
}

export interface CommentsSurfaceHost {
  /** Mounts the site's page into `body`. */
  mountPage(body: HTMLElement, url: string): CommentsPage
  /** The mode changed; the panel updates its toggle button. */
  modeChanged(mode: CommentsMode, canRead: boolean): void
}

export function commentsFailureNote(error: unknown): string {
  const name = error instanceof Error ? error.name : ""
  if (name === "CommentsAuthError") return "Sign in to the site in a tab to read this thread here. Showing the page instead."
  if (name === "CommentsNotFoundError") return "The thread could not be found. Showing the page instead."
  if (name === "TimeoutError") return "The thread took too long to load. Showing the page instead."
  return "The thread could not be read. Showing the page instead."
}

export class CommentsSurface {
  private mode: CommentsMode = "page"
  private view: CommentThreadView | null = null
  private page: CommentsPage | null = null
  private generation = 0
  private readonly note: HTMLElement

  constructor(
    private readonly panel: HTMLElement,
    private readonly body: HTMLElement,
    private readonly host: CommentsSurfaceHost,
    private url: string
  ) {
    this.note = document.createElement("p")
    this.note.className = "comments_panel_note"
    this.note.hidden = true
    this.note.setAttribute("role", "status")
    panel.insertBefore(this.note, body)
  }

  get currentUrl(): string { return this.url }
  get currentMode(): CommentsMode { return this.mode }

  canRead(url = this.url): boolean {
    return getOnceClient().canLoadComments(url)
  }

  /** Shows `url`: as a thread when it can be read, else as the page. */
  open(url: string): void {
    this.url = url
    if (this.canRead(url)) void this.showThread()
    else this.showPage()
  }

  /** The page navigated on its own; "open in a tab" and the toggle follow it. */
  pageNavigated(url: string): void {
    if (this.mode === "page") this.url = url
  }

  toggle(): void {
    if (this.mode === "thread") this.showPage()
    else if (this.canRead()) void this.showThread()
  }

  reload(): void {
    if (this.mode === "thread") void this.showThread(true)
    else this.page?.navigate(this.url)
  }

  dispose(): void {
    this.generation++
    this.clearThread()
    this.page?.dispose()
    this.page = null
    this.note.remove()
  }

  private async showThread(refresh = false): Promise<void> {
    const generation = ++this.generation
    const url = this.url
    this.page?.dispose()
    this.page = null
    this.setMode("thread")
    this.setNote(null)
    if (!this.view) this.body.replaceChildren(loading())
    let thread: CommentThread
    try {
      thread = await getOnceClient().loadComments(url, { refresh })
    } catch (error) {
      if (generation !== this.generation) return
      this.showPage()
      this.setNote(commentsFailureNote(error))
      return
    }
    if (generation !== this.generation) return
    const previous = this.view?.selected ?? -1
    this.clearThread()
    this.view = new CommentThreadView(thread, {
      openUrl: (href, target) => getOnceClient().openUrl(href, target),
      reload: () => this.reload(),
      togglePage: () => this.toggle()
    })
    this.body.replaceChildren(this.view.root)
    this.view.activate()
    if (refresh && previous >= 0) this.view.select(previous)
  }

  private showPage(): void {
    this.generation++
    this.clearThread()
    this.setMode("page")
    this.setNote(null)
    if (this.page) this.page.navigate(this.url)
    else {
      this.body.replaceChildren()
      this.page = this.host.mountPage(this.body, this.url)
    }
  }

  private clearThread(): void {
    this.view?.dispose()
    this.view = null
  }

  private setMode(mode: CommentsMode): void {
    this.mode = mode
    this.panel.dataset.commentsMode = mode
    this.host.modeChanged(mode, this.canRead())
  }

  private setNote(text: string | null): void {
    this.note.hidden = !text
    this.note.textContent = text ?? ""
  }
}

function loading(): HTMLElement {
  const element = document.createElement("p")
  element.className = "comment_thread_loading"
  element.textContent = "Loading comments…"
  element.setAttribute("role", "status")
  return element
}
