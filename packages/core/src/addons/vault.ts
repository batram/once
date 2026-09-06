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
}

export interface AddonVaultStatus {
  state: "unavailable" | "disabled" | "locked" | "ready" | "conflict" | "error"
  message: string
  protectedStorage: boolean
}

export interface AddonVaultChoice {
  revision: string
  author: string
  updatedAt: string
  addons: string[]
  connections: string[]
}
