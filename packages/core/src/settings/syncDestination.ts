import { normalizeSyncUrl } from "./syncUrl"

/**
 * The database a sync URL points at, without its credentials: origin plus
 * path, lowercased host, no trailing slash. Two URLs with the same destination
 * reach the same database with possibly different credentials.
 */
export function syncDestination(url: string): string {
  const normalized = normalizeSyncUrl(url)
  if (!normalized) return ""
  const parsed = new URL(normalized)
  return parsed.origin + parsed.pathname.replace(/\/+$/, "")
}

export type SyncDestinationDecision =
  /** Nothing configured: no connection is attempted. */
  | { kind: "disabled" }
  /** First connection of this profile; the binding is created before connecting. */
  | { kind: "initial"; destination: string }
  /** The bound database, possibly with new credentials. */
  | { kind: "same"; destination: string }
  /** Another database than the one this profile's data came from. */
  | { kind: "different"; destination: string; bound: string }
  /** Existing local data has no trustworthy destination; a separate profile is required. */
  | { kind: "unknown-provenance"; destination: string }

export const SEPARATE_PROFILE_MESSAGE =
  "Use a separate Once profile for another sync database"

/**
 * Whether this profile may connect to `url`. `bound` is the persisted
 * destination, if any. `needsProvenance` is true when the local database
 * already holds synchronized data whose source database is not recorded.
 */
export function classifySyncDestination(
  url: string,
  bound: string,
  needsProvenance = false
): SyncDestinationDecision {
  const destination = syncDestination(url)
  if (!destination) return { kind: "disabled" }
  if (bound) {
    return destination === bound
      ? { kind: "same", destination }
      : { kind: "different", destination, bound }
  }
  return needsProvenance
    ? { kind: "unknown-provenance", destination }
    : { kind: "initial", destination }
}
