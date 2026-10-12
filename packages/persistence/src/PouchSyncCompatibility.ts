import { readSyncCompatibility, requiredSyncProtocol, SYNC_COMPAT_ID, SYNC_PROTOCOL, SyncCompatibility, SyncCompatibilityDetails } from "@once/core"
import { PouchMaintenanceDatabase } from "./PouchMaintenanceService"

export class SyncCompatibilityError extends Error {
  constructor(message: string, readonly compatibility?: SyncCompatibilityDetails) { super(message) }
}
export class PouchSyncCompatibility {
  private queue: Promise<unknown> = Promise.resolve()
  constructor(private local: PouchMaintenanceDatabase, readonly supported = SYNC_PROTOCOL) {}
  private async read(db: PouchMaintenanceDatabase, id: string, options?: Record<string, unknown>): Promise<Record<string, unknown> | null> {
    if (!db.get) throw new Error("Sync compatibility checks are unavailable on this transport")
    try { return await db.get(id, options) } catch (error) { if ((error as { status?: number }).status === 404) return null; throw error }
  }
  private async key(destination: string): Promise<string> {
    const url = new URL(destination); url.username = ""; url.password = ""; url.hash = ""
    const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(url.href.replace(/\/$/, "")))
    return `_local/once-sync-compat-${Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("")}`
  }
  private minimum(value: Record<string, unknown> | null): number {
    return value ? readSyncCompatibility({ ...value, schema: 1 }).minSyncProtocol : 1
  }
  private async remember(id: string, minimum: number): Promise<void> {
    if (!this.local.put) throw new Error("Local sync compatibility storage is unavailable")
    for (let attempt = 0; attempt < 5; attempt++) {
      const previous = await this.read(this.local, id)
      if (previous && this.minimum(previous) >= minimum) return
      try { await this.local.put({ ...previous, _id: id, minSyncProtocol: minimum }); return }
      catch (error) { if ((error as { status?: number }).status !== 409) throw error }
    }
    throw new Error("Sync compatibility changed repeatedly. Check again.")
  }
  private assertSupported(marker: SyncCompatibility): void {
    if (marker.minSyncProtocol > this.supported) throw new SyncCompatibilityError("Sync paused. This database requires a newer version of Once. Update this app to resume.", {
      supportedSyncProtocol: this.supported, requiredSyncProtocol: marker.minSyncProtocol, ...(marker.minAppVersion ? { minAppVersion: marker.minAppVersion } : {})
    })
  }
  async detect(db: PouchMaintenanceDatabase): Promise<number> {
    let minimum = 1
    for (const id of ["addon_vault", "addons"]) {
      const value = await this.read(db, id, { conflicts: true })
      if (!value) continue
      minimum = Math.max(minimum, requiredSyncProtocol(id, value.list))
      for (const rev of value._conflicts as string[] ?? []) {
        const branch = await this.read(db, id, { rev })
        minimum = Math.max(minimum, requiredSyncProtocol(id, branch?.list))
      }
    }
    return minimum
  }
  async localRequirement(version = 1): Promise<number> {
    const remembered = await this.read(this.local, "_local/once-sync-format")
    const minimum = Math.max(version, this.minimum(remembered), await this.detect(this.local))
    this.assertSupported({ schema: 1, minSyncProtocol: minimum })
    await this.remember("_local/once-sync-format", minimum)
    return minimum
  }
  check(remote: PouchMaintenanceDatabase, destination: string, requested = 1, current = () => true, scanData = true): Promise<void> {
    const work = this.queue.catch(() => undefined).then(() => this.checkNow(remote, destination, requested, current, scanData))
    this.queue = work
    return work
  }
  private async checkNow(remote: PouchMaintenanceDatabase, destination: string, requested: number, current: () => boolean, scanData: boolean): Promise<void> {
    const pinId = await this.key(destination)
    const pin = this.minimum(await this.read(this.local, pinId))
    for (let attempt = 0; attempt < 5; attempt++) {
      if (!current()) throw new Error("Sync destination changed")
      const winner = await this.read(remote, SYNC_COMPAT_ID, { conflicts: true })
      let marker: SyncCompatibility = winner ? readSyncCompatibility(winner) : { schema: 1, minSyncProtocol: 1 }
      for (const rev of winner?._conflicts as string[] ?? []) {
        const branch = readSyncCompatibility(await this.read(remote, SYNC_COMPAT_ID, { rev }))
        if (branch.minSyncProtocol > marker.minSyncProtocol) marker = branch
      }
      await this.remember(pinId, Math.max(pin, marker.minSyncProtocol))
      this.assertSupported({ ...marker, minSyncProtocol: Math.max(pin, marker.minSyncProtocol) })
      if (marker.minSyncProtocol < pin || (!winner && pin > 1)) throw new SyncCompatibilityError("Sync compatibility metadata was removed or lowered. Restore it before syncing; local data has been retained.")
      const remoteMinimum = Math.max(marker.minSyncProtocol, scanData ? await this.detect(remote) : 1)
      if (remoteMinimum > this.supported) await this.remember(pinId, remoteMinimum)
      const minimum = Math.max(remoteMinimum, requested, scanData ? await this.localRequirement() : 1)
      this.assertSupported({ ...marker, minSyncProtocol: minimum })
      if (!current()) throw new Error("Sync destination changed")
      if (winner && Number(winner.minSyncProtocol) >= minimum) return
      if (!remote.put) throw new Error("This transport cannot establish sync compatibility")
      try { await remote.put({ ...winner, _id: SYNC_COMPAT_ID, ...marker, minSyncProtocol: minimum }) }
      catch (error) { if ((error as { status?: number }).status === 409) continue; throw error }
      // Verify the server's current winning revision and all conflicts before allowing data writes.
    }
    throw new Error("Sync compatibility changed repeatedly. Check again.")
  }
}
