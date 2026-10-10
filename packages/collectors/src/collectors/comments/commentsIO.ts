import { CommentThread } from "@once/core"

/**
 * What a collector gets to read comments with. The fetch is the shell's own,
 * passed in: collectors cannot reach the platform, and a renderer's global
 * fetch would run into CORS where the shell's does not.
 */
export interface CommentsIO {
  fetch: typeof globalThis.fetch
  signal?: AbortSignal
}

/** A collector's ability to read the discussion behind a comment URL. */
export interface CommentsCapability {
  /** Whether this collector can read the comment page at `url`. */
  matches(url: string): boolean
  load(url: string, io: CommentsIO): Promise<CommentThread>
}

/**
 * The site wants a signed-in user (Reddit sends anonymous readers to its login
 * page). The view says so and shows the page instead.
 */
export class CommentsAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CommentsAuthError"
  }
}

/** The thread is not there (deleted, mistyped, or not indexed yet). */
export class CommentsNotFoundError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "CommentsNotFoundError"
  }
}

async function request(io: CommentsIO, url: string, init: RequestInit): Promise<Response> {
  const response = await io.fetch(url, { ...init, signal: io.signal })
  if (response.status === 404) throw new CommentsNotFoundError(`No thread at ${url}`)
  if (response.status === 401 || response.status === 403) throw new CommentsAuthError(`${url} wants a signed-in user (${response.status})`)
  if (!response.ok) throw new Error(`${url} answered ${response.status}`)
  return response
}

/** GETs JSON. A login page where JSON was expected counts as an auth failure. */
export async function fetchCommentsJson(io: CommentsIO, url: string, init: RequestInit = {}): Promise<unknown> {
  const response = await request(io, url, init)
  if (/\/login\b/.test(response.url)) throw new CommentsAuthError(`${url} redirected to a login page`)
  const text = await response.text()
  try {
    return JSON.parse(text)
  } catch {
    if (/^\s*</.test(text)) throw new CommentsAuthError(`${url} answered with a page, not JSON`)
    throw new Error(`${url} did not answer with JSON`)
  }
}

/** GETs an HTML page and parses it. */
export async function fetchCommentsPage(io: CommentsIO, url: string, init: RequestInit = {}): Promise<Document> {
  const response = await request(io, url, init)
  const doc = new DOMParser().parseFromString(await response.text(), "text/html")
  const base = doc.createElement("base")
  base.href = url
  doc.head?.prepend(base)
  return doc
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value)

export const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined

export const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined
