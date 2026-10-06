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
  THUMB_DOC_PREFIX,
  winningPublication,
  winningRetirement
} from "@once/core"
import type { TabDocDatabase } from "../types"

/**
 * Tab sync documents over a minimal document database: the local PouchDB in
 * apps that replicate, or CouchDB over HTTP in a background without one. All
 * conflict handling lives here so both resolve the same way.
 */
export class TabDocRepository {
  constructor(private readonly db: TabDocDatabase) {}

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
    for (const doc of await this.db.list(thumbDocPrefix(deviceId))) {
      const stored = typeof doc.createdAt === "string" ? Date.parse(doc.createdAt) : 0
      if (typeof doc._id === "string" && typeof doc._rev === "string" && !keep.has(doc._id) && !(stored > before)) {
        await this.db.remove(doc._id, doc._rev)
      }
    }
  }

  /**
   * Stores a screenshot under a name derived from its content, once: an
   * unchanged picture is never written or replicated twice.
   */
  async putThumb(deviceId: string, jpeg: string, width: number, height: number): Promise<string> {
    const id = `${thumbDocPrefix(deviceId)}${await sha1Hex(jpeg)}`
    if (await this.db.get(id)) return id
    try {
      await this.db.put({ _id: id, type: "thumb", deviceId, width, height, createdAt: new Date().toISOString(),
        _attachments: { [THUMB_ATTACHMENT]: { content_type: "image/jpeg", data: jpeg } } })
    } catch (error) {
      if (!isConflict(error)) throw error
    }
    return id
  }

  /** A screenshot as a data URL, or null while it has not arrived. */
  async thumbnail(id: string): Promise<string | null> {
    if (!id.startsWith(THUMB_DOC_PREFIX)) return null
    const doc = await this.db.get(id, { attachments: true })
    const attachment = (doc?._attachments as Record<string, { data?: unknown }> | undefined)?.[THUMB_ATTACHMENT]
    return typeof attachment?.data === "string" ? `data:image/jpeg;base64,${attachment.data}` : null
  }

  async listSends(target?: string): Promise<SendDoc[]> {
    const docs = await this.db.list(target ? sendDocPrefix(target) : SEND_DOC_PREFIX)
    return docs.map(readSendDoc).filter((doc): doc is SendDoc => doc !== null)
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

const THUMB_ATTACHMENT = "thumb.jpg"

async function sha1Hex(base64: string): Promise<string> {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index)
  const digest = await globalThis.crypto.subtle.digest("SHA-1", bytes)
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")
}

function isConflict(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { status?: unknown }).status === 409
}
