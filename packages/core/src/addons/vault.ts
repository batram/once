/** Replicated as one authenticated snapshot; ordinary list writes must not merge it. */
export const ADDON_VAULT_ID = "addon_vault"

export interface VaultRevision {
  revision: string
  value: unknown
}

export interface VaultStorePort {
  readVault(): Promise<VaultRevision[]>
  /** Compare-and-swap. Multiple parents are allowed only for an explicit resolution. */
  writeVault(value: unknown, parents: string[]): Promise<void>
  /**
   * Deletes losing branches, never the winner, and writes no new snapshot.
   * Every replica picks the same winner, so two devices settling the same
   * duplicate branches agree instead of racing each other again.
   */
  dropVaultBranches(revisions: string[]): Promise<void>
}

export interface AddonVaultStatus {
  /** "off": this device left the vault; its add-ons stay here, other devices keep syncing. */
  state: "unavailable" | "disabled" | "locked" | "ready" | "conflict" | "error" | "off"
  message: string
  protectedStorage: boolean
  /** Conflicts can be reviewed with an already remembered key. */
  unlockRequired?: boolean
}

export interface AddonVaultChoice {
  revision: string
  author: string
  updatedAt: string
  addons: string[]
  connections: string[]
  /** What the versions disagree on, such as "Name: settings" or "Token name"; the same list on every choice. */
  differences?: string[]
}
