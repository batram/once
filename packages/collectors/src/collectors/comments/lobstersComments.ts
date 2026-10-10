// Lobsters discussions. Every story page has a JSON twin (`/s/<id>.json`)
// with the complete comment list, flat and in display order, each comment
// naming its parent.
import { buildCommentTree, CommentNode, CommentThread, countComments } from "@once/core"
import {
  CommentsCapability, CommentsIO, CommentsNotFoundError, fetchCommentsJson, isRecord, num, str
} from "./commentsIO"

const SITE = "https://lobste.rs"
const STORY_PATTERN = /^https?:\/\/lobste\.rs\/s\/([a-z0-9]+)/i

export function storyId(url: string): string | undefined {
  return STORY_PATTERN.exec(url)?.[1]
}

/** Older responses carried the user as an object; current ones as a name. */
function userName(value: unknown): string | null {
  if (typeof value === "string") return value || null
  if (isRecord(value)) return str(value.username) ?? null
  return null
}

function toNode(comment: Record<string, unknown>): CommentNode {
  const id = str(comment.short_id) ?? ""
  const author = userName(comment.commenting_user)
  const removed = comment.is_deleted === true || comment.is_moderated === true
  return {
    id,
    author,
    authorUrl: author ? `${SITE}/~${encodeURIComponent(author)}` : undefined,
    avatarUrl: author ? `${SITE}/avatars/${encodeURIComponent(author)}-32.png` : undefined,
    time: Date.parse(str(comment.created_at) ?? "") || 0,
    html: str(comment.comment) ?? "",
    permalink: str(comment.short_id_url) ?? str(comment.url) ?? `${SITE}/c/${id}`,
    score: num(comment.score),
    removed,
    children: []
  }
}

/** Reads a thread from a story's JSON. */
export function threadFromStory(url: string, story: unknown): CommentThread {
  if (!isRecord(story)) throw new Error("Lobsters sent no story")
  const list = (Array.isArray(story.comments) ? story.comments : []).filter(isRecord)
  const comments = buildCommentTree(list, toNode, comment => str(comment.parent_comment))
  return {
    provider: "lobsters",
    // The slugged URL: Lobsters can serve a stale page-cache copy at /s/<id>.
    url: str(story.comments_url) ?? url,
    title: str(story.title),
    storyHtml: str(story.description) || undefined,
    storyAuthor: userName(story.submitter_user) ?? undefined,
    storyTime: Date.parse(str(story.created_at) ?? "") || undefined,
    storyScore: num(story.score),
    total: countComments(comments),
    comments,
    fetchedAt: Date.now()
  }
}

export async function load(url: string, io: CommentsIO): Promise<CommentThread> {
  const id = storyId(url)
  if (!id) throw new CommentsNotFoundError(`Not a Lobsters story: ${url}`)
  return threadFromStory(`${SITE}/s/${id}`, await fetchCommentsJson(io, `${SITE}/s/${id}.json`))
}

export const comments: CommentsCapability = {
  matches: url => storyId(url) !== undefined,
  load
}
