import { DEVICE_DOC_PREFIX, THUMB_DOC_PREFIX, SEND_DOC_PREFIX, RETIREMENT_DOC_PREFIX, readSendDoc } from "@once/core"
import { DeviceIdentity } from "./DeviceIdentity"
import { TabDocRepository } from "./TabDocRepository"
import { expiredSends } from "./tabPublication"
import { thumbnailDocumentId, resolveThumbnail } from "./ThumbnailStore"
import { withLock } from "./locks"

const INTERVAL = 60 * 60 * 1000
const BATCH = 100
interface Progress { lastCompletedAt?: string; thumbs?: string | null; sends?: string | null; pending?: boolean }
export interface TabSyncStorage {
  devices: number
  screenshots: number
  screenshotBytes: number
  sends: number
  retirements: number
  lastCompletedAt: string | null
  pending: boolean
  server?: TabSyncStorage["database"] | null
  serverUnavailable?: boolean
  database: { doc_count?: number; doc_del_count?: number; sizes?: { file?: number; active?: number }; compact_running?: boolean }
}

/** Slow, resumable maintenance, independent of tab capture and publication. */
export class TabSyncMaintenance {
  constructor(private readonly repository: TabDocRepository, private readonly identity: DeviceIdentity,
    private readonly allowed: () => Promise<boolean>, private readonly grace: number) {}

  private async progress(): Promise<Progress> {
    try { return JSON.parse(await this.identity.readMaintenance() || "{}") as Progress } catch { return {} }
  }

  private async page(prefix: string, after?: string) {
    if (this.repository.db.page) return this.repository.db.page(prefix, after, BATCH)
    const all = (await this.repository.db.list(prefix)).filter((doc) => !after || String(doc._id) > after)
    const docs = all.slice(0, BATCH)
    return { docs, ...(all.length > BATCH ? { next: String(docs[docs.length - 1]._id) } : {}) }
  }

  async run(retentionDays: number, force = false): Promise<void> {
    await withLock("once-tabsync-maintenance", async () => {
      if (!await this.allowed()) {
        if (force) throw new Error("Turn on tab sync and connect sync before running cleanup.")
        return
      }
      const progress = await this.progress()
      if (!force && !progress.pending && Date.now() - Date.parse(progress.lastCompletedAt ?? "") < INTERVAL) return
      const devices = new Map((await this.repository.listDevices()).map((doc) => [doc.deviceId, doc]))
      const retirements = new Map((await this.repository.listRetirements()).map((doc) => [doc.deviceId, doc]))
      const referenced = new Set([...devices.values()].flatMap((device) => device.windows.flatMap((window) =>
        window.tabs.flatMap((tab) => tab.thumb ? [thumbnailDocumentId(tab.thumb.id)] : []))))
      const thumbs = progress.pending && progress.thumbs === null ? { docs: [], next: undefined } : await this.page(THUMB_DOC_PREFIX, progress.thumbs ?? undefined)
      for (const raw of thumbs.docs) {
        if (!await this.allowed()) return
        const doc = raw._conflicts ? await resolveThumbnail(this.repository.db, raw) : raw
        if (typeof doc._id !== "string" || typeof doc._rev !== "string" || referenced.has(doc._id) ||
            !(Date.parse(String(doc.createdAt)) < Date.now() - this.grace)) continue
        if (doc._id.includes("_slot_")) {
          if (doc._attachments) {
            const { _attachments: _removed, ...empty } = doc
            await this.repository.db.put({ ...empty, contentHash: "" })
          }
        } else await this.repository.db.remove(doc._id, doc._rev)
      }
      const sends = progress.pending && progress.sends === null ? { docs: [], next: undefined } : await this.page(SEND_DOC_PREFIX, progress.sends ?? undefined)
      const expired = expiredSends(sends.docs.flatMap((doc) => readSendDoc(doc) ?? []), devices, retirements, retentionDays)
      for (const send of expired) {
        if (!await this.allowed()) return
        await this.repository.deleteSend(send)
      }
      // Each cursor is exclusive, even when its document was just deleted.
      const pending = Boolean(thumbs.next || sends.next)
      if (!await this.allowed()) return
      await this.identity.writeMaintenance(JSON.stringify({ thumbs: pending ? thumbs.next ?? null : undefined, sends: pending ? sends.next ?? null : undefined, pending,
        lastCompletedAt: pending ? progress.lastCompletedAt : new Date().toISOString() }))
    })
  }

  async storage(): Promise<TabSyncStorage> {
    const progress = await this.progress()
    const result: TabSyncStorage = { devices: 0, screenshots: 0, screenshotBytes: 0, sends: 0, retirements: 0,
      lastCompletedAt: progress.lastCompletedAt ?? null, pending: progress.pending === true,
      database: await this.repository.db.info?.() ?? {} }
    for (const [prefix, key] of [[DEVICE_DOC_PREFIX, "devices"], [THUMB_DOC_PREFIX, "screenshots"],
      [SEND_DOC_PREFIX, "sends"], [RETIREMENT_DOC_PREFIX, "retirements"]] as const) {
      let after: string | undefined
      do {
        const page = await this.page(prefix, after)
        for (const doc of page.docs) {
          if (key !== "screenshots") result[key]++
          else if (doc._attachments) {
            result.screenshots++
            for (const attachment of Object.values(doc._attachments as Record<string, { length?: number }>)) {
              result.screenshotBytes += attachment.length ?? 0
            }
          }
        }
        after = page.next
      } while (after)
    }
    return result
  }
}
