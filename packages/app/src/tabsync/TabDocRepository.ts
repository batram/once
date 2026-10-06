import {
  DeviceDoc,
  deviceDocId,
  DEVICE_DOC_PREFIX,
  readDeviceDoc,
  readRetirementDoc,
  readSendDoc,
  RetirementDoc,
  retirementDocId,
  RETIREMENT_DOC_PREFIX,
  SendDoc,
  sendDocPrefix,
  SEND_DOC_PREFIX,
  thumbDocPrefix,
  winningPublication,
  winningRetirement
} from "@once/core"
import { ThumbnailStore, thumbnailDocumentId } from "./ThumbnailStore"
import type { TabDocDatabase } from "../types"

/**
 * Tab sync documents over a minimal document database: the local PouchDB in
 * apps that replicate, or CouchDB over HTTP in a background without one. All
 * conflict handling lives here so both resolve the same way.
 */
export class TabDocRepository {
  constructor(readonly db: TabDocDatabase) {}

  /**
   * The winning publication of a device, after deleting the losing leaves.
   * Every device picks the same winner (highest epoch, then sequence, then
   * revision), so concurrent resolvers agree. Conflicts arise not only from
   * copied profiles: an offline device that publishes past the revision limit
   * loses its common ancestry with the server.
   */
  async resolveDevice(deviceId: string): Promise<DeviceDoc | null> {
    const id = deviceDocId(deviceId)
    const current = await this.db.get(id, { conflicts: true })
    if (!current) return null
    const conflicts = Array.isArray(current._conflicts) ? current._conflicts.filter((rev): rev is string => typeof rev === "string") : []
    const leaves = [current]
    for (const rev of conflicts) {
      const leaf = await this.db.get(id, { rev })
      if (leaf) leaves.push(leaf)
    }
    const readable = leaves.map(readDeviceDoc).filter((doc): doc is DeviceDoc => doc !== null)
    const winner = winningPublication(readable)
    for (const leaf of leaves) {
      if (typeof leaf._rev === "string" && leaf._rev !== winner?._rev) await this.db.remove(id, leaf._rev)
    }
    return winner
  }

  /** Writes a publication on top of the current winner, resolving conflicts first. */
  async publish(doc: Omit<DeviceDoc, "_rev">): Promise<DeviceDoc> {
    for (let attempt = 0; ; attempt++) {
      const current = await this.resolveDevice(doc.deviceId)
      const next: DeviceDoc = current?._rev ? { ...doc, _rev: current._rev } : { ...doc }
      try {
        const { rev } = await this.db.put(next as unknown as Record<string, unknown>)
        return { ...next, _rev: rev }
      } catch (error) {
        if (attempt >= 2 || !isConflict(error)) throw error
      }
    }
  }

  /** Every device's winning publication, conflicts resolved. */
  async listDevices(): Promise<DeviceDoc[]> {
    const docs = await this.db.list(DEVICE_DOC_PREFIX)
    const devices: DeviceDoc[] = []
    for (const raw of docs) {
      const doc = readDeviceDoc(raw)
      if (!doc) continue
      devices.push(Array.isArray(raw._conflicts) && raw._conflicts.length ? await this.resolveDevice(doc.deviceId) ?? doc : doc)
    }
    return devices
  }

  async readRetirement(deviceId: string): Promise<RetirementDoc | null> {
    return this.resolveRetirement(await this.db.get(retirementDocId(deviceId), { conflicts: true }))
  }

  async listRetirements(): Promise<RetirementDoc[]> {
    const records: RetirementDoc[] = []
    for (const raw of await this.db.list(RETIREMENT_DOC_PREFIX)) {
      const record = await this.resolveRetirement(raw)
      if (record) records.push(record)
    }
    return records
  }

  /** Retires a device up to `retiredEpoch`; an existing higher retirement stays. */
  async retire(record: Omit<RetirementDoc, "_id" | "_rev" | "type">): Promise<void> {
    const id = retirementDocId(record.deviceId)
    for (let attempt = 0; ; attempt++) {
      const current = await this.readRetirement(record.deviceId)
      if (current && current.retiredEpoch >= record.retiredEpoch) return
      const doc: Record<string, unknown> = { _id: id, type: "retirement", ...record }
      if (current?._rev) doc._rev = current._rev
      try {
        await this.db.put(doc)
        return
      } catch (error) {
        if (attempt >= 2 || !isConflict(error)) throw error
      }
    }
  }

  /** Removes a device's publication, every conflicting leaf included. */
  async deleteDevice(deviceId: string): Promise<void> {
    const id = deviceDocId(deviceId)
    const current = await this.db.get(id, { conflicts: true })
    if (!current) return
    const revs = [current._rev, ...(Array.isArray(current._conflicts) ? current._conflicts : [])]
    for (const rev of revs) if (typeof rev === "string") await this.db.remove(id, rev)
  }

  /**
   * Removes a device's screenshots, except those in `keep` (still referenced)
   * and those stored after `before` (a grace period, so a device that has
   * not yet received the newer publication can still show them).
   */
  async deleteThumbs(deviceId: string, keep: ReadonlySet<string> = new Set(), before = Infinity): Promise<void> {
    const kept = new Set([...keep].map(thumbnailDocumentId))
    for (const doc of await this.db.list(thumbDocPrefix(deviceId))) {
      const stored = typeof doc.createdAt === "string" ? Date.parse(doc.createdAt) : 0
      if (typeof doc._id === "string" && typeof doc._rev === "string" && !kept.has(doc._id) && !(stored > before)) {
        await this.db.remove(doc._id, doc._rev)
      }
    }
  }

  /** Bounded reusable screenshot slots; the hash in the reference rejects stale images. */
  putThumb(deviceId: string, jpeg: string, width: number, height: number, keep: ReadonlySet<string> = new Set()): Promise<string | null> {
    return new ThumbnailStore(this.db).put(deviceId, jpeg, width, height, keep)
  }

  thumbnail(id: string): Promise<string | null> { return new ThumbnailStore(this.db).get(id) }

  async listSends(target?: string): Promise<SendDoc[]> {
    const docs = await this.db.list(target ? sendDocPrefix(target) : SEND_DOC_PREFIX)
    return docs.map(readSendDoc).filter((doc): doc is SendDoc => doc !== null)
  }

  /** A tab sent to another device; only the target removes it, or anyone once it has expired. */
  async putSend(target: string, send: Omit<SendDoc, "_id" | "_rev" | "type">): Promise<SendDoc> {
    const id = `${sendDocPrefix(target)}${globalThis.crypto.randomUUID().replace(/-/g, "")}`
    const doc = { _id: id, type: "send" as const, ...send }
    const { rev } = await this.db.put(doc as unknown as Record<string, unknown>)
    return { ...doc, _rev: rev }
  }

  async deleteSend(doc: Pick<SendDoc, "_id" | "_rev">): Promise<void> {
    if (doc._rev) await this.db.remove(doc._id, doc._rev)
  }

  private async resolveRetirement(raw: Record<string, unknown> | null): Promise<RetirementDoc | null> {
    if (!raw || typeof raw._id !== "string") return null
    const leaves = [raw]
    for (const rev of Array.isArray(raw._conflicts) ? raw._conflicts : []) {
      if (typeof rev !== "string") continue
      const leaf = await this.db.get(raw._id, { rev })
      if (leaf) leaves.push(leaf)
    }
    const readable = leaves.map(readRetirementDoc).filter((doc): doc is RetirementDoc => doc !== null)
    const winner = winningRetirement(readable)
    for (const leaf of leaves) {
      if (typeof leaf._rev === "string" && leaf._rev !== winner?._rev) await this.db.remove(raw._id, leaf._rev)
    }
    return winner
  }
}

function isConflict(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { status?: unknown }).status === 409
}
