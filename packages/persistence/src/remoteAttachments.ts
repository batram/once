/**
 * Fetch attachment bytes inside CouchDB JSON. Intermediaries may rewrite a raw
 * text/html attachment (for example email obfuscation) without changing its rev.
 * JSON/base64 preserves the stored bytes and is also pinned to the requested rev.
 */
export function protectRemoteAttachments<T extends PouchDB.Database>(db: T): T {
  const pending = new Map<string, Promise<{ _attachments?: Record<string, { data?: string; content_type?: string }> }>>()
  db.getAttachment = ((id: string, attachment: string, options?: { rev?: string } | ((error: unknown, data?: unknown) => void),
    callback?: (error: unknown, data?: unknown) => void) => {
    const done = typeof options === "function" ? options : callback
    const rev = typeof options === "object" ? options.rev : undefined
    const key = JSON.stringify([id, rev])
    let read = pending.get(key)
    if (!read) {
      const encoded = id.startsWith("_design/") ? "_design/" + encodeURIComponent(id.slice(8)) : encodeURIComponent(id)
      const transport = db as T & { fetch(path: string, options: RequestInit): Promise<Response> }
      // PouchDB.get({attachments:true}) itself fetches raw URLs, so use the JSON
      // transport directly instead of delegating to that convenience method.
      read = transport.fetch(encoded + "?attachments=true" + (rev ? "&rev=" + encodeURIComponent(rev) : ""),
        { headers: new Headers({ Accept: "application/json" }) }).then(async response => {
        if (!response.ok) throw Object.assign(new Error("Attachment document request failed"), { status: response.status })
        return response.json()
      })
      pending.set(key, read)
      void read.finally(() => pending.delete(key)).catch(() => undefined)
    }
    const result = read.then(doc => {
      const entry = doc._attachments?.[attachment]
      const data = entry?.data
      if (data === undefined) throw Object.assign(new Error("Attachment not found"), { status: 404, name: "not_found" })
      const nodeBuffer = (globalThis as { Buffer?: { from(data: string, encoding: string): Uint8Array } }).Buffer
      return nodeBuffer ? nodeBuffer.from(data, "base64")
        : new Blob([Uint8Array.from(atob(data), char => char.charCodeAt(0))], { type: entry?.content_type })
    })
    if (done) void result.then(data => done(null, data), error => done(error))
    return result
  }) as T["getAttachment"]
  return db
}
