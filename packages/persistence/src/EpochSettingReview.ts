import type { SyncSettingReview, SyncSettingResolution } from "@once/core"
import type { EpochCopyDatabase } from "./PouchEpochCopy"
import { epochContent } from "./EpochContent"

const labels: Record<string, string> = {
  swipe: "Swipe settings", theme: "Theme", animation: "Animations", sources: "Sources",
  story_sources: "Sources", filter_list: "Filters", redirect_list: "Redirects",
  cache_timing: "Cache timing", save_bookmarked_content: "Saved bookmark content"
}

export function reviewableSetting(id: string): string | undefined { return Object.hasOwn(labels, id) ? labels[id] : undefined }

export const reviewableSettingIds = Object.keys(labels)

export class EpochSettingReviewError extends Error {
  constructor(readonly documentId: string) {
    super(`Choose which ${labels[documentId] ?? "setting"} to keep in Settings → Sync. All local versions are retained.`)
  }
}

type Doc = Record<string, unknown> & { _id: string; _rev: string }
type SettingDatabase = Pick<EpochCopyDatabase, "get" | "put" | "bulkDocs">

async function leaves(db: SettingDatabase, id: string): Promise<Doc[]> {
  try {
    const result = await db.get(id, { open_revs: "all", revs: true }) as unknown as Array<{ ok?: Doc }>
    if (!Array.isArray(result) || result.some(row => !row.ok)) throw new Error("Could not read every setting version")
    return result.map(row => row.ok as Doc)
  } catch (error) {
    if ((error as { status?: number }).status === 404) return []
    throw error
  }
}

function value(doc: Doc): Record<string, unknown> {
  if (doc._attachments) throw new Error("This setting has attachments and needs separate recovery; no versions were removed")
  return Object.fromEntries(Object.entries(doc).filter(([key]) => !key.startsWith("_")))
}

function ancestor(rev: string, doc: Doc): boolean {
  if (rev === doc._rev) return true
  const [generation, hash] = rev.split("-")
  const history = doc._revisions as { start: number; ids: string[] } | undefined
  return history?.ids[history.start - Number(generation)] === hash
}

async function readVersions(local: SettingDatabase, remote: SettingDatabase, id: string) {
  if (!reviewableSetting(id)) throw new Error("This document needs its own recovery controls; no settings were changed")
  const [localLeaves, remoteLeaves] = await Promise.all([leaves(local, id), leaves(remote, id)])
  const localLive = localLeaves.filter(doc => !doc._deleted)
  const remoteLive = remoteLeaves.filter(doc => !doc._deleted)
  if (!localLive.length) throw new Error("The local setting no longer exists. Check sync again.")
  if (remoteLive.length > 1) throw new Error("The synced setting also has conflicting versions. Keep this device's data and resolve the shared conflict before moving.")
  const localWinner = await local.get(id) as Doc
  // A deleted remote document has a real revision that must not be mistaken for absence.
  const remoteWinner = remoteLive[0] ?? remoteLeaves.sort((a, b) => Number(b._rev.split("-")[0]) - Number(a._rev.split("-")[0]) || b._rev.localeCompare(a._rev))[0]
  return { localLeaves, localLive, localWinner, remoteWinner }
}

export async function reviewEpochSetting(local: SettingDatabase, remote: SettingDatabase, id: string): Promise<SyncSettingReview> {
  const { localLeaves, localWinner, remoteWinner } = await readVersions(local, remote, id)
  const candidates = [
    ...(remoteWinner && !remoteWinner._deleted ? [{ key: "remote", label: "Synced version", value: value(remoteWinner) }] : []),
    { key: localWinner._rev, label: "This device’s current version", value: value(localWinner) }
  ]
  const seen = new Set<string>(), choices: SyncSettingReview["choices"] = []
  for (const candidate of candidates) {
    const content = await epochContent(candidate.value)
    if (!seen.has(content)) { seen.add(content); choices.push(candidate) }
  }
  return {
    id, label: labels[id], localRevisions: localLeaves.map(doc => doc._rev).sort(), remoteRevision: remoteWinner?._rev ?? null,
    currentLocalRevision: localWinner._rev, choices
  }
}

/** Caller holds the local epoch write lock. Never writes to the remote database. */
export async function resolveEpochSetting(local: SettingDatabase, remote: SettingDatabase, choice: SyncSettingResolution,
  isCurrent = () => true): Promise<void> {
  const { localLeaves, localLive, localWinner, remoteWinner } = await readVersions(local, remote, choice.id)
  const expected = [...choice.localRevisions].sort()
  if (JSON.stringify(localLeaves.map(doc => doc._rev).sort()) !== JSON.stringify(expected) || (remoteWinner?._rev ?? null) !== choice.remoteRevision) {
    throw new Error("This setting changed while you were reviewing it. Review the versions again; nothing was changed.")
  }
  const selected = choice.choice === "remote" ? remoteWinner : localLive.find(doc => doc._rev === choice.choice)
  if (!selected || selected._deleted) throw new Error("Choose one of the reviewed versions")
  value(selected) // Refuse attachments before creating a backup or changing any branch.
  let parent = remoteWinner ? localLive.find(doc => doc._rev === localWinner._rev && ancestor(remoteWinner._rev, doc)) ??
    localLeaves.find(doc => ancestor(remoteWinner._rev, doc)) : localWinner
  // Keep every original branch and its ancestry before any resolution write.
  if (!isCurrent()) throw new Error("The sync session changed. Review again.")
  await local.put({ _id: `_local/once-setting-review-${crypto.randomUUID()}`, version: 1, id: choice.id,
    selected: choice.choice, at: new Date().toISOString(), local: localLeaves, remote: remoteWinner ?? null })
  if (!isCurrent()) throw new Error("The sync session changed. Your backup is retained; review again.")
  if (!parent && remoteWinner) {
    const results = await local.bulkDocs([remoteWinner], { new_edits: false })
    if (results.some(row => row.error)) throw new Error("Could not prepare the synced setting; the backup is retained")
    parent = remoteWinner
  }
  if (!parent) throw new Error("No revision is available for this setting")
  if (!isCurrent()) throw new Error("The sync session changed. Your backup is retained; review again.")
  const written = choice.choice === "remote" && parent._rev === remoteWinner?._rev ? { rev: parent._rev }
    : await local.put({ _id: choice.id, _rev: parent._rev, ...value(selected) })
  if (!written.rev) throw new Error("The selected setting could not be saved")
  const after = await leaves(local, choice.id)
  const unexpected = after.filter(doc => !doc._deleted && doc._rev !== written.rev && !expected.includes(doc._rev))
  if (unexpected.length) throw new Error("Another setting version arrived. Your choice and backup are retained; review again.")
  const losing = after.filter(doc => !doc._deleted && doc._rev !== written.rev && expected.includes(doc._rev))
  if (!isCurrent()) throw new Error("The sync session changed. Your choice and backup are retained; review again.")
  if (losing.length) {
    const results = await local.bulkDocs(losing.map(doc => ({ _id: choice.id, _rev: doc._rev, _deleted: true })))
    if (results.some(row => row.error)) throw new Error("A setting changed during resolution. The backup is retained; review again.")
  }
}
