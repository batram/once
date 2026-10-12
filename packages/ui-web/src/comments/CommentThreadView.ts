// A discussion Once read itself (see the collectors' comments capability),
// laid out the way the aggregators do it: each comment a header (collapse
// toggle, author, age linking to the comment, score) over its text, replies nested below.
// The view keeps the comments as a flat list in reading order too, which is
// what keyboard and swipe navigation move through.
import { CommentNode, CommentThread, humanTime } from "@once/core"
import { sanitizedFragmentDocument } from "../reader/sanitizeHtml"
import { collapseStep, expandStep, NavComment, nextIndex, previousIndex } from "./commentNavigation"
import { attachCommentFolding, CommentFolding, scrollerOf } from "./commentFolding"
import { attachCommentSwipe } from "./commentSwipe"

export interface CommentThreadViewOptions {
  /** Opens a link: "current" for a plain click, "middle" for a background tab. */
  openUrl(url: string, target: "current" | "middle"): void
  reload?(): void
  togglePage?(): void
  /** Puts a "show the page" button in the thread's header, where no toolbar offers one. */
  pageButton?: boolean
  /** A swipe right on an open comment shows only it and its replies, for a narrow screen. */
  foldDepth?: boolean
}

interface Entry {
  node: CommentNode
  element: HTMLElement
  depth: number
  collapsed: boolean
}

/** Top-level comments drawn per frame, so a long thread shows its start at once. */
const BATCH = 20
/** Clicks this close in time and place are one double (or triple) click, wherever the comments moved. */
const MULTI_CLICK_MS = 400
const MULTI_CLICK_PX = 24

interface ClickChain {
  time: number
  x: number
  y: number
  count: number
  /** Whether this run of clicks already collapsed or expanded a comment. */
  toggled: boolean
  /** Whether the toggle or the rail did it, where every click counts on its own. */
  byControl?: boolean
}

const keyboardTarget: { view: CommentThreadView | null } = { view: null }

/** The thread the keyboard drives, if one is shown. */
export function activeCommentThread(): CommentThreadView | null {
  const view = keyboardTarget.view
  return view && view.root.isConnected ? view : null
}

export class CommentThreadView {
  readonly root: HTMLElement
  private readonly list: HTMLElement
  private readonly entries: Entry[] = []
  private readonly byElement = new WeakMap<HTMLElement, number>()
  private current = -1
  private frame = 0
  private disposeSwipe: () => void = () => {}
  private folding: CommentFolding | null = null
  private clicks: ClickChain | null = null

  constructor(private readonly thread: CommentThread, private readonly options: CommentThreadViewOptions) {
    this.root = element("section", "comment_thread")
    this.root.dataset.testid = "comment-thread"
    this.root.dataset.provider = thread.provider
    this.list = element("div", "comment_list")
    this.list.setAttribute("role", "tree")
    this.list.setAttribute("aria-label", "Comments")
    this.root.append(this.header(), this.list)
    if (thread.comments.length === 0) this.list.append(element("p", "comment_thread_empty", "No comments yet."))
    if (thread.more) this.root.append(this.moreLink(thread.more, "more comments"))
    this.root.addEventListener("mousedown", event => this.onMouseDown(event))
    this.root.addEventListener("click", event => this.onClick(event))
    this.root.addEventListener("auxclick", event => this.onAuxClick(event))
    this.disposeSwipe = attachCommentSwipe(this.root, {
      indexOf: target => this.indexOf(target),
      swipe: (index, direction) => {
        this.select(index, false)
        if (direction < 0) this.collapse()
        else if (!this.focus(index)) this.expand()
      }
    })
    if (options.foldDepth) this.folding = attachCommentFolding(this.root)
    this.renderFrom(0)
  }

  /** Marks this view as the one the keyboard drives while it is shown. */
  activate(): void {
    if (keyboardTarget.view !== this) keyboardTarget.view?.deactivate()
    keyboardTarget.view = this
    this.root.dataset.keys = "on"
  }

  deactivate(): void {
    if (keyboardTarget.view === this) keyboardTarget.view = null
    delete this.root.dataset.keys
  }

  dispose(): void {
    this.deactivate()
    cancelAnimationFrame(this.frame)
    this.disposeSwipe()
    this.folding?.dispose()
    this.root.remove()
  }

  next(): void { this.select(nextIndex(this.navItems(), this.current)) }
  previous(): void { this.select(previousIndex(this.navItems(), this.current)) }

  collapse(): void {
    // Done with a focused comment: back to the thread around it, where it collapses in place.
    if (this.folding?.focused && this.folding.focused === this.entries[this.current]?.element) this.folding.back()
    const step = collapseStep(this.navItems(), this.current)
    if (step.collapse) this.setCollapsed(this.current, true)
    if (step.target >= 0) this.select(step.target)
    else if (step.collapse) this.reveal(this.current)
  }

  expand(): void {
    const step = expandStep(this.navItems(), this.current)
    if (step.expand) this.setCollapsed(this.current, false)
    this.select(step.target)
  }

  openPermalink(target: "current" | "middle" = "current"): void {
    const entry = this.entries[this.current]
    if (entry) this.options.openUrl(entry.node.permalink, target)
  }

  reload(): void { this.options.reload?.() }
  togglePage(): void { this.options.togglePage?.() }

  /** The selected comment's index, for tests and the swipe handler. */
  get selected(): number { return this.current }

  select(index: number, scroll = true): void {
    const entry = this.entries[index]
    if (!entry) return
    const previous = this.entries[this.current]
    if (previous) {
      previous.element.classList.remove("is-current")
      previous.element.removeAttribute("aria-current")
      previous.element.tabIndex = -1
    }
    this.current = index
    entry.element.classList.add("is-current")
    entry.element.setAttribute("aria-current", "true")
    entry.element.tabIndex = 0
    if (this.root.contains(document.activeElement) || document.activeElement === document.body) {
      entry.element.focus({ preventScroll: true })
    }
    if (scroll) this.reveal(index)
  }

  /** Brings the whole comment into view, or its start when it is taller than the view. */
  private reveal(index: number): void {
    const main = this.entries[index]?.element.querySelector(":scope > .comment_main")
    if (!main) return
    main.scrollIntoView({ block: "nearest" })
    const view = scrollerOf(this.root)?.getBoundingClientRect() ?? { top: 0, bottom: window.innerHeight }
    const top = main.getBoundingClientRect().top
    if (top < view.top || top > view.bottom) main.scrollIntoView({ block: "start" })
  }

  /** Focuses an open comment, where the view folds; false when it does not. */
  private focus(index: number): boolean {
    const entry = this.entries[index]
    if (!this.folding || !entry || entry.collapsed) return false
    this.folding.focus(entry.element)
    return true
  }

  private navItems(): NavComment[] {
    // Reading order makes "hidden" one pass: everything deeper than the most
    // recent collapsed comment, until the list climbs back to its depth.
    let collapsedAt = -1
    const focused = this.folding?.focused
    return this.entries.map(entry => {
      const hidden = (collapsedAt >= 0 && entry.depth > collapsedAt) || (!!focused && !focused.contains(entry.element))
      if (!hidden) collapsedAt = entry.collapsed ? entry.depth : -1
      return { depth: entry.depth, collapsed: entry.collapsed, hidden }
    })
  }

  private setCollapsed(index: number, collapsed: boolean): void {
    const entry = this.entries[index]
    if (!entry) return
    entry.collapsed = collapsed
    entry.element.classList.toggle("is-collapsed", collapsed)
    entry.element.setAttribute("aria-expanded", String(!collapsed))
    const toggle = entry.element.querySelector<HTMLButtonElement>(":scope > .comment_main .comment_toggle")
    if (toggle) {
      // The chevron turns on screen; a screen reader also hears how many replies it hides.
      const hiddenReplies = countAll(entry.node.children)
      toggle.setAttribute("aria-label", !collapsed ? "Collapse comment"
        : hiddenReplies ? `Expand comment, ${hiddenReplies} ${hiddenReplies === 1 ? "reply" : "replies"} hidden` : "Expand comment")
    }
  }

  private indexOf(target: EventTarget | null): number {
    const article = (target as Element | null)?.closest?.(".comment")
    return article instanceof HTMLElement ? this.byElement.get(article) ?? -1 : -1
  }

  // Pointer rules: a double click (or tap) on an open comment's header line
  // collapses it, one click anywhere on a collapsed comment opens it, and the
  // toggle and the rail work on every click. The text stays the browser's, for
  // selecting words to quote, and a header double click toggles at most once.
  private onClick(event: MouseEvent): void {
    const target = event.target as Element | null
    const link = target?.closest?.("a[href]") as HTMLAnchorElement | null
    // A link inside a collapsed comment's one-line preview is cut off and unreadable: the click opens the comment.
    const previewLink = link?.closest(".comment.is-collapsed > .comment_main > .comment_body")
    if (link && this.root.contains(link) && !previewLink) {
      event.preventDefault()
      this.options.openUrl(link.href, event.ctrlKey || event.metaKey ? "middle" : "current")
      return
    }
    if (previewLink) event.preventDefault()
    if (target?.closest?.(".comment_thread_reload")) return this.reload()
    if (target?.closest?.(".comment_thread_page")) return this.togglePage()
    const index = this.indexOf(target)
    if (index < 0) return
    if (target?.closest?.(".comment_focus")) {
      this.select(index, false)
      this.setCollapsed(index, false)
      this.focus(index)
      return
    }
    const control = target?.closest?.(".comment_toggle, .comment_rail")
    const click = this.countClick(event, !!control)
    // A drag that selected text, or a shift-click extending it, is not a click on the comment.
    if (!control && (event.shiftKey || window.getSelection()?.toString())) return
    this.select(index, false)
    if (click.toggled) return
    const oneClick = control || this.entries[index].collapsed
    const toggle = oneClick ? click.count === 1 : click.count === 2 && !!target?.closest?.(".comment_head")
    if (!toggle) return
    click.toggled = true
    click.byControl = !!control
    this.setCollapsed(index, !this.entries[index].collapsed)
    this.reveal(index)
  }

  /** Counted here rather than from dblclick, which touch webviews fire unevenly for a double tap. */
  private countClick(event: MouseEvent, control: boolean): ClickChain {
    const now = Date.now()
    const last = this.clicks
    // A key press on the toggle has no place on screen, and clicking the toggle
    // or rail again flips it again: each counts alone. Only the rest of a
    // header double click that toggled, landing on a toggle that slid under
    // the pointer, stays part of that run.
    const alone = control && (event.detail === 0 || !last?.toggled || !!last.byControl)
    const near = !!last && Math.hypot(event.clientX - last.x, event.clientY - last.y) < MULTI_CLICK_PX
    if (last && near && !alone && now - last.time < MULTI_CLICK_MS) {
      Object.assign(last, { time: now, x: event.clientX, y: event.clientY, count: last.count + 1 })
      return last
    }
    this.clicks = { time: now, x: event.clientX, y: event.clientY, count: 1, toggled: false }
    return this.clicks
  }

  /** Keeps a double click that toggles from also selecting the word under it. */
  private onMouseDown(event: MouseEvent): void {
    if (event.detail < 2) return
    const target = event.target as Element | null
    if (!target?.closest?.(".comment") || target.closest("a[href]")) return
    const toggled = !!this.clicks?.toggled && Date.now() - this.clicks.time < MULTI_CLICK_MS
    // On the header the double click is the collapse; drag still selects the
    // author or the age. After a toggle, the second press lands on text that just moved.
    if (toggled || target.closest(".comment_head")) event.preventDefault()
  }

  private onAuxClick(event: MouseEvent): void {
    if (event.button !== 1) return
    const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null
    if (!link || !this.root.contains(link)) return
    event.preventDefault()
    this.options.openUrl(link.href, "middle")
  }

  private renderFrom(start: number): void {
    const end = Math.min(start + BATCH, this.thread.comments.length)
    const fragment = document.createDocumentFragment()
    for (let i = start; i < end; i++) fragment.append(this.renderComment(this.thread.comments[i], 0))
    this.list.append(fragment)
    if (end < this.thread.comments.length) this.frame = requestAnimationFrame(() => this.renderFrom(end))
  }

  private renderComment(node: CommentNode, depth: number): HTMLElement {
    const article = element("article", "comment")
    article.dataset.id = node.id
    article.dataset.depth = String(depth)
    article.dataset.testid = "comment"
    article.style.setProperty("--comment-depth", String(depth))
    article.setAttribute("role", "treeitem")
    article.setAttribute("aria-level", String(depth + 1))
    article.setAttribute("aria-expanded", "true")
    article.tabIndex = -1
    if (node.removed) article.classList.add("is-removed")
    if (this.isStoryAuthor(node)) article.classList.add("is-op")
    const index = this.entries.push({ node, element: article, depth, collapsed: false }) - 1
    this.byElement.set(article, index)

    const main = element("div", "comment_main")
    main.append(this.renderHead(node), this.renderBody(node))
    if (node.more && node.more.count > 0) main.append(this.moreLink(node.more, node.more.count === 1 ? "more reply" : "more replies"))
    // The gutter beside the text and down the replies, as on Reddit: a click collapses the comment.
    const rail = element("button", "comment_rail") as HTMLButtonElement
    rail.type = "button"
    rail.tabIndex = -1
    rail.setAttribute("aria-label", "Collapse comment")
    article.append(main, rail)
    if (node.children.length) {
      const replies = element("div", "comment_replies")
      replies.setAttribute("role", "group")
      for (const child of node.children) replies.append(this.renderComment(child, depth + 1))
      article.append(replies)
    }
    return article
  }

  private renderHead(node: CommentNode): HTMLElement {
    const head = element("header", "comment_head")
    const toggle = element("button", "comment_toggle") as HTMLButtonElement
    toggle.type = "button"
    toggle.setAttribute("aria-label", "Collapse comment")
    head.append(toggle)
    if (node.avatarUrl) {
      const avatar = element("img", "comment_avatar") as HTMLImageElement
      avatar.alt = ""
      avatar.loading = "lazy"
      avatar.referrerPolicy = "no-referrer"
      avatar.src = node.avatarUrl
      head.append(avatar)
    }
    head.append(node.author
      ? link("comment_author", node.author, node.authorUrl)
      : element("span", "comment_author is-anonymous", "[deleted]"))
    if (this.isStoryAuthor(node)) {
      const op = element("span", "comment_op", "OP")
      op.title = "Original poster"
      head.append(op)
    }
    // The age is the permalink, as on the sites themselves.
    const permalink = link("comment_permalink", node.time ? undefined : "link", node.permalink)
    if (node.time) {
      const time = element("time", "comment_time", humanTime(node.time)) as HTMLTimeElement
      time.dateTime = new Date(node.time).toISOString()
      time.title = new Date(node.time).toLocaleString()
      permalink.append(time)
    }
    if (permalink.firstChild) head.append(permalink)
    if (node.score !== undefined) {
      head.append(element("span", "comment_score", points(node.score)))
    }
    // The way into a subthread without the swipe: its reply count, as Slack and X show it.
    const replies = countAll(node.children)
    if (this.options.foldDepth && replies) {
      const count = `${replies} ${replies === 1 ? "reply" : "replies"}`
      const focus = element("button", "comment_focus", count) as HTMLButtonElement
      focus.type = "button"
      focus.setAttribute("aria-label", `Show only this thread, ${count}`)
      head.append(focus)
    }
    return head
  }

  private isStoryAuthor(node: CommentNode): boolean {
    return !!node.author && node.author === this.thread.storyAuthor
  }

  private renderBody(node: CommentNode): HTMLElement {
    const body = element("div", "comment_body")
    if (node.removed && !node.html) {
      body.append(element("p", "comment_removed", "[removed]"))
      return body
    }
    const doc = sanitizedFragmentDocument(node.html, node.permalink)
    body.append(...Array.from(doc.body.childNodes))
    wrapLeadingText(body)
    return body
  }

  private header(): HTMLElement {
    const thread = this.thread
    const header = element("header", "comment_thread_head")
    const title = link("comment_thread_title", thread.title || thread.url, thread.url)
    const meta = element("p", "comment_thread_meta")
    const bits = [
      thread.storyScore !== undefined ? points(thread.storyScore) : "",
      thread.storyAuthor ? `by ${thread.storyAuthor}` : "",
      thread.storyTime ? humanTime(thread.storyTime) : "",
      `${thread.total} ${thread.total === 1 ? "comment" : "comments"}${thread.partial ? " shown" : ""}`
    ].filter(Boolean)
    meta.textContent = bits.join(" · ")
    const actions = element("div", "comment_thread_actions")
    if (this.options.pageButton) actions.append(iconButton("comment_thread_page", "article", "Show the comment page"))
    actions.append(iconButton("comment_thread_reload", "reload", "Reload comments"))
    header.append(title, meta, actions)
    if (thread.storyHtml) {
      const story = element("div", "comment_thread_story")
      story.append(...Array.from(sanitizedFragmentDocument(thread.storyHtml, thread.url).body.childNodes))
      header.append(story)
    }
    return header
  }

  private moreLink(more: { count: number; url: string }, noun: string): HTMLElement {
    return link("comment_more", `${more.count} ${noun} on the site`, more.url)
  }
}

const points = (score: number) => `${score} ${Math.abs(score) === 1 ? "point" : "points"}`

function countAll(nodes: readonly CommentNode[]): number {
  return nodes.reduce((total, node) => total + 1 + countAll(node.children), 0)
}

function iconButton(className: string, icon: string, label: string): HTMLButtonElement {
  const button = element("button", `button button--icon ${className}`) as HTMLButtonElement
  button.type = "button"
  button.title = label
  button.setAttribute("aria-label", label)
  const glyph = element("span", `icon icon--chrome icon--${icon}`)
  glyph.setAttribute("aria-hidden", "true")
  button.append(glyph)
  return button
}

function element(tag: string, className: string, text?: string): HTMLElement {
  const created = document.createElement(tag)
  created.className = className
  if (text !== undefined) created.textContent = text
  return created
}

const BLOCKS = new Set(["P", "DIV", "PRE", "BLOCKQUOTE", "UL", "OL", "TABLE", "HR", "H1", "H2", "H3", "H4", "H5", "H6"])

/**
 * Hacker News sends a comment's first paragraph as bare text and only the
 * rest as <p>; Lobsters and Reddit wrap every one. Wrapping the leading text
 * gives every site the same shape, so the first paragraph starts at the same
 * height everywhere and the rail line beside it can start there too.
 */
function wrapLeadingText(body: HTMLElement): void {
  const leading: ChildNode[] = []
  for (const child of Array.from(body.childNodes)) {
    if (child.nodeType === 1 && BLOCKS.has((child as Element).tagName)) break
    leading.push(child)
  }
  if (!leading.some(child => child.textContent?.trim() || (child.nodeType === 1 && (child as Element).tagName === "IMG"))) return
  const paragraph = document.createElement("p")
  body.insertBefore(paragraph, leading[0])
  paragraph.append(...leading)
}

function link(className: string, text: string | undefined, href?: string): HTMLElement {
  if (!href) return element("span", className, text)
  const anchor = element("a", className, text) as HTMLAnchorElement
  anchor.href = href
  anchor.rel = "noopener noreferrer"
  return anchor
}
