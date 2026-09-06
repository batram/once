/** Only explicitly selected extension storage keys belong in the synced database. */
export interface ExtensionSyncEntry {
  local: string[]
  sync: string[]
  values: { local: Record<string, unknown>; sync: Record<string, unknown> }
}

export interface BrowserExtensionSyncDocument {
  version: 1
  extensions: Record<string, ExtensionSyncEntry>
}

export const BROWSER_EXTENSION_SYNC_ID = "browser_extension_sync"

export function readBrowserExtensionSync(value: unknown): BrowserExtensionSyncDocument {
  const result: BrowserExtensionSyncDocument = { version: 1, extensions: {} }
  if (!value || typeof value !== "object") return result
  const entries = (value as BrowserExtensionSyncDocument).extensions
  if (!entries || typeof entries !== "object" || Array.isArray(entries)) return result
  for (const [id, entry] of Object.entries(entries)) {
    if (!entry || typeof entry !== "object") continue
    const keys = (area: "local" | "sync"): string[] => Array.isArray(entry[area])
      ? [...new Set(entry[area].filter(key => typeof key === "string"))].sort() : []
    const local = keys("local"), sync = keys("sync")
    const selected = (area: "local" | "sync", names: string[]) => Object.fromEntries(names
      .filter(key => Object.hasOwn(entry.values?.[area] ?? {}, key))
      .map(key => [key, entry.values[area][key]]))
    Object.defineProperty(result.extensions, id, { enumerable: true, configurable: true, writable: true,
      value: { local, sync, values: { local: selected("local", local), sync: selected("sync", sync) } } })
  }
  return result
}
