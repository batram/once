/** Canonical content, independent of revision ancestry and attachment transport encoding. */
export async function epochContent(doc: Record<string, unknown>): Promise<string> {
  const revisionFields = new Set(["_rev", "_revisions", "_revs_info", "_conflicts", "_deleted_conflicts"])
  const content = Object.fromEntries(Object.entries(doc).filter(([key]) => !revisionFields.has(key)))
  if (doc._attachments) {
    const attachments: Record<string, unknown> = {}
    for (const [name, raw] of Object.entries(doc._attachments as Record<string, Record<string, unknown>>)) {
      if (raw.data === undefined) throw new Error(`Epoch verification requires attachment bytes: ${String(doc._id)}/${name}`)
      const bytes = await attachmentBytes(raw.data)
      const hash = await sha256(bytes)
      if (typeof raw.length === "number" && raw.length !== bytes.length) throw new Error(`Attachment length check failed: ${String(doc._id)}/${name}`)
      // CouchDB may hash its compressed representation; Pouch hashes decoded bytes.
      // Transport digests cannot establish semantic equality across adapters.
      attachments[name] = { content_type: raw.content_type, hash }
      if (doc.type === "thumb" && name === "thumb.jpg" && typeof doc.contentHash === "string") {
        const actual = await digest("SHA-1", bytes)
        if (actual !== doc.contentHash) throw new Error(`Attachment integrity check failed: ${String(doc._id)}/${name}`)
      }
      const meta = doc.stored_content as { fingerprint?: string } | undefined
      if (name === "content" && meta?.fingerprint) {
        const text = new TextDecoder().decode(bytes)
        let legacy = 0x811c9dc5
        for (let index = 0; index < text.length; index++) legacy = Math.imul(legacy ^ text.charCodeAt(index), 0x01000193)
        const expected = meta.fingerprint.startsWith("sha256:") ? `sha256:${hash}` : `${text.length}-${(legacy >>> 0).toString(16)}`
        if (meta.fingerprint !== expected) throw new Error(`Attachment integrity check failed: ${String(doc._id)}/${name}`)
      }
    }
    content._attachments = attachments
  }
  return JSON.stringify(canonical(content))
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical)
  if (!value || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, entry]) => [key, canonical(entry)]))
}

async function attachmentBytes(data: unknown): Promise<Uint8Array<ArrayBuffer>> {
  if (typeof data === "string") return Uint8Array.from(atob(data), char => char.charCodeAt(0))
  if (typeof Blob !== "undefined" && data instanceof Blob) return new Uint8Array(await data.arrayBuffer())
  if (data instanceof Uint8Array) return new Uint8Array(data)
  throw new Error("Unsupported attachment encoding during epoch verification")
}

export function sha256(bytes: Uint8Array<ArrayBuffer>): Promise<string> { return digest("SHA-256", bytes) }

async function digest(algorithm: string, bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  return Array.from(new Uint8Array(await crypto.subtle.digest(algorithm, bytes)), byte => byte.toString(16).padStart(2, "0")).join("")
}
