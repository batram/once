import { thumbDocPrefix, THUMB_DOC_PREFIX } from "@once/core"
import type { TabDocDatabase } from "../types"

/** Reusable records bound screenshot identity growth, even across restarts. */
export const THUMBNAIL_SLOTS = 128
const MAX_BYTES = 64 * 1024
const ATTACHMENT = "thumb.jpg"
export const thumbnailDocumentId = (reference: string): string => reference.split("#")[0]

export class ThumbnailStore {
  constructor(private readonly db: TabDocDatabase) {}

  async put(deviceId: string, jpeg: string, width: number, height: number, keep: ReadonlySet<string>): Promise<string | null> {
    const bytes = Uint8Array.from(atob(jpeg), (char) => char.charCodeAt(0))
    if (bytes.length > MAX_BYTES) return null
    const digest = await crypto.subtle.digest("SHA-1", bytes)
    const hash = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
    const prefix = `${thumbDocPrefix(deviceId)}slot_`
    const slots = await Promise.all((await this.db.list(prefix)).map((doc) => resolveThumbnail(this.db, doc)))
    const same = slots.find((slot) => slot.contentHash === hash && slot._attachments)
    if (same) {
      // Renew the collection grace before a formerly unreferenced picture is
      // published again. A concurrent collector must conflict with this write.
      try { await this.db.put({ ...same, createdAt: new Date().toISOString() }) }
      catch (error) {
        if ((error as { status?: number }).status === 409) return null
        throw error
      }
      return `${same._id}#${hash}`
    }
    const protectedIds = new Set([...keep].map(thumbnailDocumentId))
    const reusable = slots.filter((slot) => !protectedIds.has(String(slot._id)))
      .sort((a, b) => Number(Boolean(a._attachments)) - Number(Boolean(b._attachments)) || Date.parse(String(a.createdAt)) - Date.parse(String(b.createdAt)))
    const used = new Set(slots.map((slot) => slot._id))
    const free = Array.from({ length: THUMBNAIL_SLOTS }, (_, index) => `${prefix}${String(index).padStart(3, "0")}`).find((id) => !used.has(id))
    const existing = reusable.find((slot) => !slot._attachments) ?? (free ? undefined : reusable[0])
    const id = existing?._id ?? free
    if (typeof id !== "string") return null // More open pictures than the bounded cache can hold.
    const doc = { _id: id, ...(existing?._rev ? { _rev: existing._rev } : {}), type: "thumb", deviceId,
      width, height, contentHash: hash, createdAt: new Date().toISOString(),
      _attachments: { [ATTACHMENT]: { content_type: "image/jpeg", data: jpeg } } }
    try { await this.db.put(doc) } catch (error) {
      if ((error as { status?: number }).status === 409) return null
      throw error
    }
    // A stale snapshot must never show the new contents of a reused slot.
    return `${id}#${hash}`
  }

  async get(reference: string): Promise<string | null> {
    if (!reference.startsWith(THUMB_DOC_PREFIX)) return null
    const [id, hash] = reference.split("#")
    const raw = await this.db.get(id, { attachments: true, conflicts: true })
    const doc = raw ? await resolveThumbnail(this.db, raw, true) : null
    if (hash && doc?.contentHash !== hash) return null
    const attachment = (doc?._attachments as Record<string, { data?: unknown }> | undefined)?.[ATTACHMENT]
    return typeof attachment?.data === "string" ? `data:image/jpeg;base64,${attachment.data}` : null
  }
}

/** Reused slots can fork after long offline histories; losing attachments must go too. */
export async function resolveThumbnail(db: TabDocDatabase, doc: Record<string, unknown>, attachments = false): Promise<Record<string, unknown>> {
  const leaves = [doc]
  for (const rev of Array.isArray(doc._conflicts) ? doc._conflicts : []) {
    if (typeof rev !== "string") continue
    const leaf = await db.get(String(doc._id), { rev, attachments })
    if (leaf) leaves.push(leaf)
  }
  leaves.sort((a, b) => String(b.createdAt ?? "").localeCompare(String(a.createdAt ?? "")) || String(b._rev).localeCompare(String(a._rev)))
  const [winner] = leaves
  for (const losing of leaves.slice(1)) {
    if (typeof losing._rev === "string") await db.remove(String(doc._id), losing._rev)
  }
  return winner
}
