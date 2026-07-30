import { Story } from "@once/core"

const syncedStoryFields = ["read_state", "stared", "filter"] as const

export function mergeStorySyncState(local: Story, remote: Story): Story {
  const merged = Story.from_obj(local.to_obj())
  const timestamps = { ...local.sync_updated_at }

  syncedStoryFields.forEach((field) => {
    const localTime = local.sync_updated_at?.[field] ?? 0
    const remoteTime = remote.sync_updated_at?.[field] ?? 0
    const useRemote =
      remoteTime > localTime ||
      (remoteTime === localTime &&
        legacyStoryFieldRank(field, remote[field]) >
          legacyStoryFieldRank(field, local[field]))
    if (useRemote) merged[field] = remote[field] as never
    const latest = Math.max(localTime, remoteTime)
    if (latest > 0) timestamps[field] = latest
  })

  if (Object.keys(timestamps).length > 0) {
    merged.sync_updated_at = timestamps
  }
  return merged
}

export function acceptRemoteStorySyncState(local: Story, remote: Story): Story {
  const accepted = Story.from_obj(local.to_obj())
  syncedStoryFields.forEach((field) => {
    accepted[field] = remote[field] as never
  })
  accepted.sync_updated_at = remote.sync_updated_at
    ? { ...remote.sync_updated_at }
    : undefined
  return accepted
}

export function sameStorySyncState(a: Story, b: Story): boolean {
  if (!syncedStoryFields.every((field) => a[field] === b[field])) return false
  const aUpdates = a.sync_updated_at ?? {}
  const bUpdates = b.sync_updated_at ?? {}
  const updateFields = new Set([
    ...Object.keys(aUpdates),
    ...Object.keys(bUpdates)
  ])
  return Array.from(updateFields).every(
    (field) => aUpdates[field] === bUpdates[field]
  )
}

function legacyStoryFieldRank(
  field: typeof syncedStoryFields[number],
  value: unknown
): number {
  if (field === "read_state") {
    if (value === "skipped") return 2
    if (value === "read") return 1
    return 0
  }
  if (field === "stared") return value === true ? 1 : 0
  return typeof value === "string" && value ? 1 : 0
}
