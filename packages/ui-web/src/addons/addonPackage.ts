import { OnceClient } from "@once/app"
import { AddonEntry, AddonManifest, SANDBOX_LIMITS, grantedFetchPatterns, validateConfig } from "@once/core"
import { AddonSandbox } from "./AddonSandbox"

let sandboxUrl: string | undefined
export function configureAddonPackages(url?: string): void { sandboxUrl = url }

/** Both installation and execution use the same integrity check, including cached code. */
export async function verifiedAddonScript(client: OnceClient, manifest: AddonManifest): Promise<string | null> {
  if (!manifest.script) return null
  const { integrity, url } = manifest.script
  const cached = await client.getAddonScript(integrity).catch(() => null)
  const code = cached ?? await client.fetchText(url)
  const bytes = new TextEncoder().encode(code)
  if (bytes.length > SANDBOX_LIMITS.code) throw new Error("The script is too large")
  const digest = await crypto.subtle.digest("SHA-256", bytes)
  const actual = `sha256-${btoa(String.fromCharCode(...new Uint8Array(digest)))}`
  if (actual !== integrity) throw new Error("Script integrity does not match the manifest")
  if (cached === null) await client.storeAddonScript(integrity, code)
  return code
}

/** Validate activation before changing the installed document; trial storage is discarded. */
export async function prepareAddon(client: OnceClient, entry: AddonEntry): Promise<void> {
  const code = await verifiedAddonScript(client, entry.manifest)
  if (code === null || !sandboxUrl) return
  const settings = entry.manifest.settings
    ? validateConfig(entry.manifest.settings, entry.options ?? {}) as Record<string, unknown> : {}
  const grants = grantedFetchPatterns(entry.manifest)
  const storage = structuredClone(entry.storage ?? {})
  const trial = new AddonSandbox(entry.manifest.id, sandboxUrl, code, () => settings, {
    report: () => undefined,
    perform: async op => {
      if (op.name === "storage.get") return storage[op.key]
      if (op.name === "storage.set") {
        storage[op.key] = op.value
        if (JSON.stringify(storage).length > SANDBOX_LIMITS.storageBytes) throw new Error("Storage is full")
        return
      }
      if (op.name === "fetch" && grants.matches(op.url)) {
        return { status: 200, text: await client.fetchText(op.url) }
      }
      throw new Error("This operation is unavailable during activation")
    }
  })
  try { await trial.ensure() } finally { trial.dispose() }
}
