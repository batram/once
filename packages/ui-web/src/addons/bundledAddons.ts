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
  // An older app must never roll a shared package (or its offer marker) back.
  // Unknown version formats require an explicit import instead of guessing.
  if (offered !== undefined && !newerVersion(version, offered)) return null
  if (installed && isBundledAddon(installed)) return newerVersion(version, installed.manifest.version) ? "upgrade" : "mark"
  if (installed) return "mark"
  return offered === undefined ? "install" : "mark"
}

function newerVersion(next: string, previous: string): boolean {
  const parse = (value: string) => /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([\da-zA-Z.-]+))?(?:\+[\da-zA-Z.-]+)?$/.exec(value)
  const left = parse(next), right = parse(previous)
  if (!left || !right) return false
  for (let i = 1; i <= 3; i++) {
    if (Number(left[i]) !== Number(right[i])) return Number(left[i]) > Number(right[i])
  }
  if (!left[4] || !right[4]) return !left[4] && !!right[4]
  const a = left[4].split("."), b = right[4].split(".")
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (a[i] === b[i]) continue
    if (a[i] === undefined || b[i] === undefined) return b[i] === undefined
    const an = /^\d+$/.test(a[i]), bn = /^\d+$/.test(b[i])
    if (an && bn) return Number(a[i]) > Number(b[i])
    return an !== bn ? !an : a[i] > b[i]
  }
  return false
}

function applyPlan(doc: AddonsDocument, pack: LocalAddonPackage): AddonsDocument {
  const { id, version } = pack.entry.manifest
  const step = plan(doc, pack)
  if (step === null) return doc
  const next = { ...doc, bundled: { ...doc.bundled, [id]: version } }
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
