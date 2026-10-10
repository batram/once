// Hacker News discussions. Algolia's item API returns a whole tree in one
// request, which the official Firebase API cannot (one request per comment).
// Algolia lags new items by a few minutes, so an empty or missing tree falls
// back to the item page itself.
import { CommentNode, CommentThread, countComments } from "@once/core"
import {
  CommentsCapability, CommentsIO, CommentsNotFoundError,
  fetchCommentsJson, fetchCommentsPage, isRecord, num, str
} from "./commentsIO"

const SITE = "https://news.ycombinator.com/"
const ITEM_PATTERN = /^https?:\/\/news\.ycombinator\.com\/item\?(?:.*&)?id=(\d+)/i

export function itemId(url: string): string | undefined {
  return ITEM_PATTERN.exec(url)?.[1]
}

const permalink = (id: string | number) => `${SITE}item?id=${id}`
const userUrl = (user: string) => `${SITE}user?id=${encodeURIComponent(user)}`

function fromAlgolia(item: Record<string, unknown>): CommentNode | null {
  if (item.type !== "comment") return null
  const id = String(item.id)
  const author = str(item.author) ?? null
  const html = str(item.text) ?? ""
  return {
    id,
    author,
    authorUrl: author ? userUrl(author) : undefined,
    time: (num(item.created_at_i) ?? 0) * 1000,
    html,
    permalink: permalink(id),
    removed: !author && !html,
    children: algoliaChildren(item)
  }
}

function algoliaChildren(item: Record<string, unknown>): CommentNode[] {
  const children = Array.isArray(item.children) ? item.children : []
  return children.filter(isRecord).map(fromAlgolia).filter((node): node is CommentNode => node !== null)
}

/** Reads a thread from Algolia's item API. */
export function threadFromAlgolia(url: string, item: unknown): CommentThread {
  if (!isRecord(item)) throw new Error("Algolia sent no item")
  const comments = algoliaChildren(item)
  return {
    provider: "hackernews",
    url,
    title: str(item.title),
    storyHtml: str(item.text) || undefined,
    storyAuthor: str(item.author),
    storyTime: (num(item.created_at_i) ?? 0) * 1000 || undefined,
    storyScore: num(item.points),
    total: countComments(comments),
    comments,
    fetchedAt: Date.now()
  }
}

/** HN's age titles are UTC without a zone, sometimes followed by unix seconds. */
function ageTime(title: string | null): number {
  if (!title) return 0
  const [iso, unix] = title.split(" ")
  if (unix && /^\d+$/.test(unix)) return Number(unix) * 1000
  const parsed = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso + "Z")
  return Number.isNaN(parsed) ? 0 : parsed
}

/** Reads a thread from an item page, nesting rows by their indent. */
export function threadFromItemPage(url: string, doc: Document): CommentThread {
  const roots: CommentNode[] = []
  const open: CommentNode[] = []
  for (const row of Array.from(doc.querySelectorAll<HTMLElement>("tr.athing.comtr"))) {
    const depth = Number(row.querySelector(".ind")?.getAttribute("indent") ?? 0) || 0
    const author = row.querySelector(".hnuser")?.textContent?.trim() || null
    const text = row.querySelector(".commtext")
    const node: CommentNode = {
      id: row.id,
      author,
      authorUrl: author ? userUrl(author) : undefined,
      time: ageTime(row.querySelector(".age")?.getAttribute("title") ?? null),
      html: text?.innerHTML ?? "",
      permalink: permalink(row.id),
      removed: !author || !text,
      children: []
    }
    open.length = Math.min(open.length, depth)
    const parent = open[open.length - 1]
    if (parent) parent.children.push(node)
    else roots.push(node)
    open.push(node)
  }
  const more = doc.querySelector<HTMLAnchorElement>("a.morelink")
  return {
    provider: "hackernews",
    url,
    title: doc.querySelector(".fatitem .titleline > a")?.textContent ?? undefined,
    storyHtml: doc.querySelector(".fatitem .toptext")?.innerHTML || undefined,
    storyAuthor: doc.querySelector(".fatitem .hnuser")?.textContent ?? undefined,
    storyScore: Number.parseInt(doc.querySelector(".fatitem .score")?.textContent ?? "", 10) || undefined,
    total: countComments(roots),
    comments: roots,
    partial: more !== null,
    fetchedAt: Date.now()
  }
}

export async function load(url: string, io: CommentsIO): Promise<CommentThread> {
  const id = itemId(url)
  if (!id) throw new CommentsNotFoundError(`Not a Hacker News item: ${url}`)
  const canonical = permalink(id)
  try {
    const thread = threadFromAlgolia(canonical, await fetchCommentsJson(io, `https://hn.algolia.com/api/v1/items/${id}`))
    if (thread.total > 0) return thread
  } catch (error) {
    if (io.signal?.aborted) throw error
  }
  return threadFromItemPage(canonical, await fetchCommentsPage(io, canonical))
}

export const comments: CommentsCapability = {
  matches: url => itemId(url) !== undefined,
  load
}
