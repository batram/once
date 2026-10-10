/**
 * A discussion read from an aggregator (Hacker News, Lobsters, Reddit and the
 * like), shaped the same way whichever site it came from, so one view can show
 * any of them. Collectors that can read a site's comments produce it; the
 * bodies stay as the site sent them and are sanitized where they are shown.
 */

/** One comment and its replies. */
export interface CommentNode {
  /** The site's own id, unique within the thread. */
  id: string
  /** Null when the comment was deleted or its author is gone. */
  author: string | null
  authorUrl?: string
  /** A small picture of the author, when the site has one. */
  avatarUrl?: string
  /** When it was written, in milliseconds since the epoch. */
  time: number
  /** The body as HTML from the site: untrusted until sanitized for display. */
  html: string
  /** A link to this comment on the site. */
  permalink: string
  score?: number
  /** Deleted, removed or flagged dead: shown as a placeholder with its replies. */
  removed?: boolean
  children: CommentNode[]
  /** Replies the site did not send with the thread, and where to read them. */
  more?: { count: number; url: string }
}

/** A whole discussion: the post it belongs to and its comment tree. */
export interface CommentThread {
  /** The collector id that read it. */
  provider: string
  /** The comment page it was read for. */
  url: string
  title?: string
  /** The post's own text (a self post, an Ask HN), as untrusted HTML. */
  storyHtml?: string
  storyAuthor?: string
  storyTime?: number
  storyScore?: number
  /** How many comments the tree holds. */
  total: number
  comments: CommentNode[]
  /** True when the site sent only part of the discussion. */
  partial?: boolean
  /** Top-level comments the site held back, and where to read them. */
  more?: { count: number; url: string }
  fetchedAt: number
}

/**
 * Turns a flat list (each item naming its parent) into a tree, keeping the
 * list's order among siblings. Items whose parent is missing become top-level
 * rather than vanishing.
 */
export function buildCommentTree<T>(
  items: readonly T[],
  toNode: (item: T) => CommentNode,
  parentOf: (item: T) => string | null | undefined
): CommentNode[] {
  const nodes = new Map<string, CommentNode>()
  const pairs = items.map(item => {
    const node = toNode(item)
    nodes.set(node.id, node)
    return { node, parent: parentOf(item) }
  })
  const roots: CommentNode[] = []
  for (const { node, parent } of pairs) {
    const owner = parent ? nodes.get(parent) : undefined
    if (owner && owner !== node) owner.children.push(node)
    else roots.push(node)
  }
  return roots
}

/** The number of comments in a tree, replies included. */
export function countComments(nodes: readonly CommentNode[]): number {
  let total = 0
  const stack = [...nodes]
  for (let node = stack.pop(); node; node = stack.pop()) {
    total++
    stack.push(...node.children)
  }
  return total
}
