import { ADDON_VAULT_ID, VaultRevision } from "@once/core"

export interface VaultDatabase {
  get(id: string, options?: Record<string, unknown>): Promise<{
    _rev?: string; _conflicts?: string[]; list?: unknown
  }>
  put(doc: Record<string, unknown>): Promise<unknown>
}

export async function readVault(db: VaultDatabase): Promise<VaultRevision[]> {
  try {
    const winner = await db.get(ADDON_VAULT_ID, { conflicts: true })
    if (!winner._rev) throw new Error("Vault revision is missing")
    const revisions = [{ revision: winner._rev, value: winner.list }]
    for (const rev of winner._conflicts ?? []) {
      const branch = await db.get(ADDON_VAULT_ID, { rev })
      revisions.push({ revision: rev, value: branch.list })
    }
    return revisions
  } catch (error) {
    if ((error as { status?: number }).status === 404) return []
    throw error
  }
}

export async function writeVault(db: VaultDatabase, value: unknown, parents: string[]): Promise<void> {
  const current = await readVault(db)
  const expected = [...parents].sort().join(",")
  if (current.map(item => item.revision).sort().join(",") !== expected) {
    throw new Error("Synced connections changed. Review the latest version and try again.")
  }
  // Never retry a 409 with a new parent: that would silently overwrite another edit.
  await db.put({ _id: ADDON_VAULT_ID, ...(current[0] ? { _rev: current[0].revision } : {}), list: value })
  for (const branch of current.slice(1)) {
    await db.put({ _id: ADDON_VAULT_ID, _rev: branch.revision, _deleted: true })
  }
}

export async function dropVaultBranches(db: VaultDatabase, revisions: string[]): Promise<void> {
  const current = await readVault(db)
  if (revisions.includes(current[0]?.revision ?? "")) throw new Error("The current vault version cannot be dropped")
  // A branch already gone was dropped by another device settling the same pair.
  for (const branch of current.slice(1)) {
    if (revisions.includes(branch.revision)) await db.put({ _id: ADDON_VAULT_ID, _rev: branch.revision, _deleted: true })
  }
}
