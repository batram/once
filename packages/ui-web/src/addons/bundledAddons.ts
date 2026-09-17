import { OnceClient } from "@once/app"
import { AddonEntry, AddonsDocument, upsertAddon } from "@once/core"
import { BUNDLED_SCRIPT_PREFIX, LocalAddonPackage, readBundledAddon } from "./localAddonPackage"

/**
 * Add-ons that ship inside Once. The build inlines each package's files, so
 * every install carries them; the first start installs them into the synced
 * `addons` document like a local import, and records that it did. A user
 * removes one like any other add-on, and the record keeps it from coming
 * back, on this device or any other the document syncs to. A newer Once
 * carrying a newer package upgrades a still-installed bundled copy, keeping
 * the user's options and storage as an update from a URL would.
 */
export interface BundledAddonFiles {
  /** The package's files by name: `once-addon.json` and the script it names. */
  files: Record<string, string>
}

let packages: Promise<LocalAddonPackage[]> = Promise.resolve([])

export function configureBundledAddons(bundled: readonly BundledAddonFiles[] = []): void {
  packages = Promise.all(bundled.map(async ({ files }) => {
    try {
      return await readBundledAddon(files)
    } catch (error) {
      console.error("A bundled add-on could not be read", error)
      return null
    }
  })).then(read => read.filter((pack): pack is LocalAddonPackage => pack !== null))
}

export function listBundledAddons(): Promise<LocalAddonPackage[]> {
  return packages
}

/** The code of a bundled package whose script carries this hash, for a synced entry not cached here yet. */
export async function bundledAddonScript(integrity: string): Promise<string | null> {
  const pack = (await packages).find(pack => pack.entry.manifest.script?.integrity === integrity)
  return pack?.code ?? null
}

export function isBundledAddon(entry: AddonEntry): boolean {
  return entry.manifest.script?.url.startsWith(BUNDLED_SCRIPT_PREFIX) ?? false
}

/** What the document still needs for a bundled package, if anything. */
function plan(doc: AddonsDocument, pack: LocalAddonPackage): "install" | "upgrade" | "mark" | null {
  const { id, version } = pack.entry.manifest
  const installed = doc.addons.find(entry => entry.manifest.id === id)
  const offered = doc.bundled?.[id]
  if (offered === version) return null
  if (installed && isBundledAddon(installed)) return "upgrade"
  if (installed) return "mark"
  return offered === undefined ? "install" : "mark"
}

function applyPlan(doc: AddonsDocument, pack: LocalAddonPackage): AddonsDocument {
  const { id, version } = pack.entry.manifest
  const next = { ...doc, bundled: { ...doc.bundled, [id]: version } }
  const step = plan(doc, pack)
  return step === "install" || step === "upgrade" ? upsertAddon(next, pack.entry) : next
}

/**
 * Brings the document up to date with what this build carries. The script
 * goes into this device's cache first, as an import's does, so the entry
 * runs as soon as it is written. Nothing is written when nothing changed.
 */
export async function seedBundledAddons(client: OnceClient): Promise<void> {
  const bundled = await packages
  if (bundled.length === 0) return
  // With the vault locked or in conflict the document is unreadable, not
  // empty; offering the package now would write into the wrong place.
  const vault = await client.getAddonVaultStatus()
  if (vault.state === "locked" || vault.state === "conflict" || vault.state === "error") return
  const doc = await client.getAddons()
  const pending = bundled.filter(pack => plan(doc, pack) !== null)
  if (pending.length === 0) return
  for (const pack of pending) {
    const script = pack.entry.manifest.script
    if (script && pack.code !== null) await client.storeAddonScript(script.integrity, pack.code)
  }
  await client.updateAddons(current => pending.reduce(applyPlan, current))
}
