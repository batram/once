// A discussion Once read itself (see the collectors' comments capability),
// laid out the way the aggregators do it: each comment a header (collapse
// toggle, author, age, score, permalink) over its text, replies nested below.
// The view keeps the comments as a flat list in reading order too, which is
// what keyboard and swipe navigation move through.
import { CommentNode, CommentThread, humanTime } from "@once/core"
import { sanitizedFragmentDocument } from "../reader/sanitizeHtml"
import { collapseStep, expandStep, NavComment, nextIndex, previousIndex } from "./commentNavigation"
import { attachCommentSwipe } from "./commentSwipe"

export interface CommentThreadViewOptions {
  /** Opens a link: "current" for a plain click, "middle" for a background tab. */
  openUrl(url: string, target: "current" | "middle"): void
  reload?(): void
  togglePage?(): void
  /** Puts a "show the page" button in the thread's header, where no toolbar offers one. */
  pageButton?: boolean
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
        else this.expand()
      }
    })
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
    this.root.remove()
  }

  next(): void { this.select(nextIndex(this.navItems(), this.current)) }
  previous(): void { this.select(previousIndex(this.navItems(), this.current)) }

  collapse(): void {
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

  private navItems(): NavComment[] {
    // Reading order makes "hidden" one pass: everything deeper than the most
    // recent collapsed comment, until the list climbs back to its depth.
    let collapsedAt = -1
    return this.entries.map(entry => {
      const hidden = collapsedAt >= 0 && entry.depth > collapsedAt
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
      // Only the replies it hides; a comment without any shows the closed chevron.
      const hiddenReplies = countAll(entry.node.children)
      toggle.textContent = collapsed && hiddenReplies ? `[+${hiddenReplies}]` : ""
      toggle.setAttribute("aria-label", collapsed ? "Expand comment" : "Collapse comment")
    }
  }

  private indexOf(target: EventTarget | null): number {
    const article = (target as Element | null)?.closest?.(".comment")
    return article instanceof HTMLElement ? this.byElement.get(article) ?? -1 : -1
  }

  // Pointer rules: a double click (or tap) on an open comment's header line
  // collapses it, one click anywhere on a collapsed comment opens it, and the
  // toggle and the rail work on one click. The text stays the browser's, for
  // selecting words to quote, and a whole double click toggles at most once.
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
    this.setCollapsed(index, !this.entries[index].collapsed)
    this.reveal(index)
  }

  /** Counted here rather than from dblclick, which touch webviews fire unevenly for a double tap. */
  private countClick(event: MouseEvent, control: boolean): ClickChain {
    const now = Date.now()
    const last = this.clicks
    // A keyboard press on the toggle has no place on screen; every one counts alone.
    const keyboard = control && event.detail === 0
    const near = !!last && Math.hypot(event.clientX - last.x, event.clientY - last.y) < MULTI_CLICK_PX
    if (last && near && !keyboard && now - last.time < MULTI_CLICK_MS) {
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
    article.append(main)
    if (node.children.length) {
      const replies = element("div", "comment_replies")
      replies.setAttribute("role", "group")
      // Down the replies' gutter, as on Reddit: a click collapses the comment.
      const rail = element("button", "comment_rail") as HTMLButtonElement
      rail.type = "button"
      rail.tabIndex = -1
      rail.setAttribute("aria-label", "Collapse comment")
      replies.append(rail)
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
    if (node.time) {
      const time = element("time", "comment_time", humanTime(node.time)) as HTMLTimeElement
      time.dateTime = new Date(node.time).toISOString()
      time.title = new Date(node.time).toLocaleString()
      head.append(time)
    }
    if (node.score !== undefined) {
      head.append(element("span", "comment_score", points(node.score)))
    }
    head.append(link("comment_permalink", "link", node.permalink))
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

function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node
  }
  return null
}

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

function link(className: string, text: string, href?: string): HTMLElement {
  if (!href) return element("span", className, text)
  const anchor = element("a", className, text) as HTMLAnchorElement
  anchor.href = href
  anchor.rel = "noopener noreferrer"
  return anchor
}
