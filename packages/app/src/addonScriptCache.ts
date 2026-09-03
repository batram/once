import { CacheStorePort } from "./types"

// Add-on code kept on this device only, keyed by its integrity hash, in the
// same store as cached feed bodies: clearing the cache means fetching again,
// nothing worse, and a synced entry still runs offline once fetched here.
const PREFIX = "addon-script:"

export async function getAddonScript(cache: CacheStorePort | undefined, integrity: string): Promise<string | null> {
  const cached = await cache?.get(`${PREFIX}${integrity}`)
  return typeof cached === "string" ? cached : null
}

export async function storeAddonScript(
  cache: CacheStorePort | undefined,
  integrity: string,
  code: string
): Promise<void> {
  await cache?.set(`${PREFIX}${integrity}`, code)
}
