// Reddit discussions, from the JSON twin of a comment page. Reddit turns
// anonymous API readers away (to its login page), so the request carries the
// shell's cookies: a reader signed in to Reddit in a tab gets the thread.
// Replies Reddit holds back ("load more comments") link to the site for now.
import { CommentNode, CommentThread, countComments } from "@once/core"
import {
  CommentsCapability, CommentsIO, CommentsNotFoundError, fetchCommentsJson, isRecord, num, str
} from "./commentsIO"

const SITE = "https://old.reddit.com"
const THREAD_PATTERNS = [
  /^https?:\/\/(?:[a-z0-9-]+\.)?reddit\.com\/(?:r\/[^/]+\/)?comments\/([a-z0-9]+)/i,
  /^https?:\/\/redd\.it\/([a-z0-9]+)/i
]

export function threadId(url: string): string | undefined {
  for (const pattern of THREAD_PATTERNS) {
    const id = pattern.exec(url)?.[1]
    if (id) return id.toLowerCase()
  }
  return undefined
}

const DELETED = new Set(["[deleted]", "[removed]"])

interface Listing { kind?: unknown; data?: { children?: unknown } }

function things(listing: unknown): Record<string, unknown>[] {
  const children = isRecord(listing) ? (listing as Listing).data?.children : undefined
  return Array.isArray(children) ? children.filter(isRecord) : []
}

function toNodes(listing: unknown, threadUrl: string, parentUrl: string): { nodes: CommentNode[]; more?: CommentNode["more"] } {
  const nodes: CommentNode[] = []
  let more: CommentNode["more"]
  for (const thing of things(listing)) {
    const data = isRecord(thing.data) ? thing.data : {}
    if (thing.kind === "more") {
      // A count of zero is Reddit's "continue this thread": the replies are
      // there, just too deep for this response.
      const count = num(data.count) || (Array.isArray(data.children) ? data.children.length : 0) || 1
      more = { count: (more?.count ?? 0) + count, url: parentUrl }
      continue
    }
    if (thing.kind !== "t1") continue
    const node = toNode(data, threadUrl)
    nodes.push(node)
  }
  return { nodes, more }
}

function toNode(data: Record<string, unknown>, threadUrl: string): CommentNode {
  const rawAuthor = str(data.author)
  const author = rawAuthor && !DELETED.has(rawAuthor) ? rawAuthor : null
  const body = str(data.body) ?? ""
  const link = str(data.permalink)
  const permalink = link ? SITE + link : threadUrl
  const replies = toNodes(data.replies, threadUrl, permalink)
  return {
    id: str(data.id) ?? str(data.name) ?? permalink,
    author,
    authorUrl: author ? `${SITE}/user/${encodeURIComponent(author)}` : undefined,
    time: (num(data.created_utc) ?? 0) * 1000,
    html: str(data.body_html) ?? "",
    permalink,
    score: data.score_hidden === true ? undefined : num(data.score),
    removed: !author && DELETED.has(body.trim()),
    children: replies.nodes,
    more: replies.more
  }
}

/** Reads a thread from a comment page's JSON: `[post listing, comment listing]`. */
export function threadFromListing(url: string, body: unknown): CommentThread {
  if (!Array.isArray(body) || body.length < 2) throw new Error("Reddit sent no thread")
  const post = things(body[0])[0]
  const data = post && isRecord(post.data) ? post.data : {}
  const top = toNodes(body[1], url, url)
  const comments = top.nodes
  const total = countComments(comments)
  const author = str(data.author)
  const announced = num(data.num_comments)
  return {
    provider: "redditjson",
    url,
    title: str(data.title),
    storyHtml: str(data.selftext_html) || undefined,
    storyAuthor: author && !DELETED.has(author) ? author : undefined,
    storyTime: (num(data.created_utc) ?? 0) * 1000 || undefined,
    storyScore: num(data.score),
    total,
    comments,
    partial: top.more !== undefined || (announced !== undefined && announced > total),
    more: top.more,
    fetchedAt: Date.now()
  }
}

export async function load(url: string, io: CommentsIO): Promise<CommentThread> {
  const id = threadId(url)
  if (!id) throw new CommentsNotFoundError(`Not a Reddit thread: ${url}`)
  const json = await fetchCommentsJson(io, `${SITE}/comments/${id}.json?raw_json=1&limit=500`, { credentials: "include" })
  return threadFromListing(`${SITE}/comments/${id}/`, json)
}

export const comments: CommentsCapability = {
  matches: url => threadId(url) !== undefined,
  load
}
