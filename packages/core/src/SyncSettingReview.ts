export interface SyncSettingReview {
  id: string
  label: string
  localRevisions: string[]
  remoteRevision: string | null
  currentLocalRevision: string
  choices: Array<{ key: string; label: string; value: Record<string, unknown> }>
}

export interface SyncSettingResolution {
  id: string
  localRevisions: string[]
  remoteRevision: string | null
  choice: string
  applyToAll?: "synced" | "local"
}
