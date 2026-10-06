const PAGE_SIZE = 200

export interface HttpStatusError extends Error { status: number }

/**
 * Tab sync documents straight on CouchDB, for an extension background that
 * cannot keep PouchDB replication running. Credentials leave the URL for an
 * Authorization header, since fetch refuses URLs that carry them. Every
 * request first asks `allowed`, which re-runs the database binding and
 * consent checks and reports whether this connection is still current.
 */
export function couchHttpTabDocs(
  syncUrl: string,
  fetchImpl: typeof fetch,
  allowed: () => Promise<boolean>
): {
  get(id: string, options?: { conflicts?: boolean; rev?: string; attachments?: boolean }): Promise<Record<string, unknown> | null>
  put(doc: Record<string, unknown>): Promise<{ rev: string }>
  remove(id: string, rev: string): Promise<void>
  list(prefix: string): Promise<Array<Record<string, unknown>>>
} {
  const parsed = new URL(syncUrl)
  const headers: Record<string, string> = { accept: "application/json" }
  if (parsed.username || parsed.password) {
    const user = decodeURIComponent(parsed.username)
    const password = decodeURIComponent(parsed.password)
    headers.authorization = `Basic ${btoa(unescape(encodeURIComponent(`${user}:${password}`)))}`
  }
  parsed.username = ""
  parsed.password = ""
  const base = parsed.href.replace(/\/+$/, "")
  const docUrl = (id: string, query: Record<string, string> = {}) => {
    const search = new URLSearchParams(query).toString()
    return `${base}/${encodeURIComponent(id)}${search ? `?${search}` : ""}`
  }

  const request = async (url: string, init: RequestInit = {}): Promise<Response> => {
    if (!await allowed()) throw statusError(0, "Sync is not allowed right now")
    return fetchImpl(url, { ...init, headers: { ...headers, ...(init.body ? { "content-type": "application/json" } : {}) } })
  }

  return {
    async get(id, options = {}) {
      const query: Record<string, string> = {}
      if (options.conflicts) query.conflicts = "true"
      if (options.rev) query.rev = options.rev
      if (options.attachments) query.attachments = "true"
      const response = await request(docUrl(id, query))
      if (response.status === 404) return null
      if (!response.ok) throw statusError(response.status, `Reading ${id} failed`)
      const doc = await response.json() as Record<string, unknown>
      return doc._deleted ? null : doc
    },
    async put(doc) {
      const id = String(doc._id)
      let response = await request(docUrl(id), { method: "PUT", body: JSON.stringify(doc) })
      // A database nobody has synced to yet; PouchDB's own HTTP adapter creates it the same way.
      if (response.status === 404) {
        await request(base, { method: "PUT" })
        response = await request(docUrl(id), { method: "PUT", body: JSON.stringify(doc) })
      }
      if (!response.ok) throw statusError(response.status, `Writing ${id} failed`)
      const result = await response.json() as { rev?: unknown }
      if (typeof result.rev !== "string") throw statusError(response.status, `Writing ${id} returned no revision`)
      return { rev: result.rev }
    },
    async remove(id, rev) {
      const response = await request(docUrl(id, { rev }), { method: "DELETE" })
      // Already gone, or already superseded by another resolver: nothing to do.
      if (!response.ok && response.status !== 404 && response.status !== 409) throw statusError(response.status, `Deleting ${id} failed`)
    },
    async list(prefix) {
      const docs: Array<Record<string, unknown>> = []
      let startkey = prefix
      let skip = 0
      for (;;) {
        // Both bounds, so a page can never run past the prefix into other documents.
        const query = new URLSearchParams({
          startkey: JSON.stringify(startkey), endkey: JSON.stringify(`${prefix}￿`),
          include_docs: "true", conflicts: "true", limit: String(PAGE_SIZE), skip: String(skip)
        })
        const response = await request(`${base}/_all_docs?${query}`)
        if (!response.ok) throw statusError(response.status, `Listing ${prefix} failed`)
        const rows = (await response.json() as { rows?: Array<{ id?: unknown; doc?: Record<string, unknown> | null }> }).rows ?? []
        for (const row of rows) {
          if (typeof row.id === "string" && row.id.startsWith(prefix) && row.doc) docs.push(row.doc)
        }
        if (rows.length < PAGE_SIZE) return docs
        const last = rows[rows.length - 1].id
        if (typeof last !== "string") return docs
        startkey = last
        skip = 1
      }
    }
  }
}

function statusError(status: number, message: string): HttpStatusError {
  return Object.assign(new Error(message), { status })
}
