// Deep threads on a narrow screen: a swipe right on an open comment focuses
// it. Only that comment and its replies stay, from the left edge at full
// width; the rest of the thread hides. A bar pinned to the top names the
// comment it replied to (or, for a top-level one, all comments) and goes
// back, one focus at a time; collapsing the focused comment goes back too.

export interface CommentFolding {
  /** Shows only the comment and its replies. */
  focus(comment: HTMLElement): void
  /** Back one focus, keeping the comment that was focused where it is on screen. */
  back(): void
  /** Whether a comment is focused, for keyboard and tests. */
  readonly focused: HTMLElement | null
  dispose(): void
}

export function attachCommentFolding(root: HTMLElement): CommentFolding {
  const stack: HTMLElement[] = []

  const bar = document.createElement("button")
  bar.type = "button"
  bar.className = "comment_context"
  bar.hidden = true
  const author = document.createElement("span")
  author.className = "comment_context_author"
  const excerpt = document.createElement("span")
  excerpt.className = "comment_context_text"
  bar.append(author, excerpt)
  root.prepend(bar)
  bar.addEventListener("click", event => {
    event.stopPropagation()
    back()
  })

  function focus(comment: HTMLElement): void {
    if (comment === stack[stack.length - 1]) return
    stack[stack.length - 1]?.classList.remove("is-focused")
    stack.push(comment)
    show()
    comment.querySelector(":scope > .comment_main")?.scrollIntoView({ block: "start" })
  }

  /** Back one focus, keeping the comment that was focused where it is on screen. */
  function back(): void {
    const comment = stack.pop()
    if (!comment) return
    const before = comment.getBoundingClientRect().top
    comment.classList.remove("is-focused")
    show()
    const scroller = scrollerOf(root)
    if (scroller) scroller.scrollTop += comment.getBoundingClientRect().top - before
  }

  function show(): void {
    const current = stack[stack.length - 1]
    root.classList.toggle("is-focusing", !!current)
    bar.hidden = !current
    if (!current) return
    current.classList.add("is-focused")
    const parent = parentOf(current)
    author.textContent = parent ? parent.querySelector(":scope > .comment_main .comment_author")?.textContent ?? "" : "All comments"
    excerpt.textContent = (parent?.querySelector(":scope > .comment_main > .comment_body")?.textContent ?? "")
      .replace(/\s+/g, " ").trim()
    bar.setAttribute("aria-label", parent ? `Back to ${author.textContent || "the thread"}` : "Back to all comments")
  }

  return {
    focus,
    back,
    get focused() { return stack[stack.length - 1] ?? null },
    dispose: () => bar.remove()
  }
}

const parentOf = (comment: HTMLElement) => comment.parentElement?.closest<HTMLElement>(".comment") ?? null

export function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) return node
  }
  return null
}
