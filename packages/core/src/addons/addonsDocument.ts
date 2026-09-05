// The synced `addons` settings doc: the add-ons a user installed, each
// with its manifest and an enabled flag. Read tolerantly like every other
// settings doc; the text form is what the settings editor shows.

import { validateConfig } from "./configSchema"
import { AddonManifest, AddonReport, readAddonManifest } from "./manifest"
import { SANDBOX_LIMITS } from "./sandboxProtocol"

export const ADDONS_DOCUMENT_ID = "addons"
export const ADDONS_VERSION = 1

export interface AddonEntry {
  enabled: boolean
  manifest: AddonManifest
  /** Where the manifest was installed from, when it came from a URL; what "check for updates" refetches. */
  source?: { url: string }
  /** The user's values for the manifest's `settings` schema; defaults fill the rest. */
  options?: Record<string, unknown>
  /** What the add-on's script stored through `once.storage`, size-capped. */
  storage?: Record<string, unknown>
}

/** Settings values that validate against the manifest's schema; anything else is dropped. */
export function readAddonOptions(manifest: AddonManifest, value: unknown): Record<string, unknown> | undefined {
  if (!manifest.settings || !isRecord(value)) return undefined
  try {
    return validateConfig(manifest.settings, value) as Record<string, unknown>
  } catch {
    return undefined
  }
}

export function readAddonStorage(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  return JSON.stringify(value).length <= SANDBOX_LIMITS.storageBytes ? value : undefined
}

function readSource(value: unknown): { url: string } | undefined {
  if (!isRecord(value) || typeof value.url !== "string") return undefined
  return /^https?:\/\//i.test(value.url) && value.url.length <= 2000 ? { url: value.url } : undefined
}

export interface AddonsDocument {
  version: number
  addons: AddonEntry[]
}

export function emptyAddonsDocument(): AddonsDocument {
  return { version: ADDONS_VERSION, addons: [] }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Another client's doc: anything unusable is dropped, silently. */
export function readAddonsDocument(value: unknown): AddonsDocument {
  const doc = emptyAddonsDocument()
  if (!isRecord(value) || value.version !== ADDONS_VERSION || !Array.isArray(value.addons)) return doc
  const seen = new Set<string>()
  for (const entry of value.addons) {
    if (!isRecord(entry)) continue
    const read = readAddonManifest(entry.manifest)
    if (!read.ok || seen.has(read.manifest.id)) continue
    seen.add(read.manifest.id)
    doc.addons.push(withExtras({ enabled: entry.enabled !== false, manifest: read.manifest }, entry))
  }
  return doc
}

/** The optional fields of an entry, each kept only when it reads cleanly. */
function withExtras(entry: AddonEntry, raw: Record<string, unknown>): AddonEntry {
  const source = readSource(raw.source)
  const options = readAddonOptions(entry.manifest, raw.options)
  const storage = readAddonStorage(raw.storage)
  return {
    ...entry,
    ...(source ? { source } : {}),
    ...(options ? { options } : {}),
    ...(storage ? { storage } : {})
  }
}

/** Adds or replaces the entry for the manifest's id, keeping the enabled flag of one already there. */
export function upsertAddon(doc: AddonsDocument, entry: AddonEntry): AddonsDocument {
  const existing = doc.addons.find((candidate) => candidate.manifest.id === entry.manifest.id)
  const merged: AddonEntry = existing ? {
    ...entry,
    enabled: existing.enabled,
    ...(existing.storage ? { storage: existing.storage } : {}),
    // Reject an incompatible update before replacing the installed entry.
    ...(entry.manifest.settings ? {
      options: validateConfig(entry.manifest.settings, existing.options ?? {}) as Record<string, unknown>
    } : {})
  } : entry
  return {
    version: doc.version,
    addons: existing
      ? doc.addons.map((candidate) => (candidate === existing ? merged : candidate))
      : [...doc.addons, merged]
  }
}

export type AddonInstallRead =
  | { ok: true; entry: AddonEntry }
  | { ok: false; reports: AddonReport[] }

/**
 * A manifest fetched from `manifestUrl`: JSON text in, an entry out. A
 * relative `script.url` resolves against the manifest's URL, so a package is
 * a directory with `once-addon.json` beside `main.js`.
 */
export function readInstalledAddon(text: string, manifestUrl: string): AddonInstallRead {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    return { ok: false, reports: [{ path: "", message: `not valid JSON: ${error instanceof Error ? error.message : String(error)}` }] }
  }
  if (isRecord(parsed) && isRecord(parsed.script) && typeof parsed.script.url === "string") {
    try {
      parsed = { ...parsed, script: { ...parsed.script, url: new URL(parsed.script.url, manifestUrl).toString() } }
    } catch {
      return { ok: false, reports: [{ path: "script.url", message: "does not resolve against the manifest URL" }] }
    }
  }
  const read = readAddonManifest(parsed)
  if (!read.ok) return read
  return { ok: true, entry: { enabled: true, manifest: read.manifest, source: { url: manifestUrl } } }
}

export class AddonsTextError extends Error {
  constructor(message: string, readonly reports: AddonReport[] = []) {
    super(message)
    this.name = "AddonsTextError"
  }
}

/**
 * The editor's text: a JSON list of manifests, each optionally carrying
 * `"enabled": false`. Unlike the tolerant reader this throws, naming every
 * problem, so the user can fix the text rather than lose an entry.
 */
export function parseAddonsText(text: string): AddonsDocument {
  const trimmed = text.trim()
  const doc = emptyAddonsDocument()
  if (trimmed === "") return doc
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch (error) {
    throw new AddonsTextError(`Not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  const list = Array.isArray(parsed) ? parsed : [parsed]
  const reports: AddonReport[] = []
  const seen = new Set<string>()
  list.forEach((entry, index) => {
    if (!isRecord(entry)) {
      reports.push({ path: `[${index}]`, message: "must be a manifest object" })
      return
    }
    const { enabled, source, options, storage, ...manifest } = entry
    const read = readAddonManifest(manifest)
    if (!read.ok) {
      reports.push(...read.reports.map((report) => ({
        path: `[${index}]${report.path ? `.${report.path}` : ""}`, message: report.message
      })))
      return
    }
    if (seen.has(read.manifest.id)) {
      reports.push({ path: `[${index}].id`, message: `${read.manifest.id} appears twice` })
      return
    }
    seen.add(read.manifest.id)
    doc.addons.push(withExtras({ enabled: enabled !== false, manifest: read.manifest }, { source, options, storage }))
  })
  if (reports.length > 0) {
    const first = reports[0]
    const more = reports.length > 1 ? ` (and ${reports.length - 1} more)` : ""
    throw new AddonsTextError(`${first.path} ${first.message}${more}`, reports)
  }
  return doc
}

/** The doc as editor text: stable key order, two-space indent. */
export function presentAddons(doc: AddonsDocument): string {
  if (doc.addons.length === 0) return ""
  const entries = doc.addons.map(({ enabled, manifest, source, options, storage }) => {
    const {
      protocol, id, name, version, author, homepage, script, contributions, collectors,
      panelActions, capabilities, settings: schema
    } = manifest
    return {
      ...(enabled ? {} : { enabled: false }),
      ...(source ? { source } : {}),
      ...(options ? { options } : {}),
      ...(storage ? { storage } : {}),
      protocol, id, name, version,
      ...(author ? { author } : {}),
      ...(homepage ? { homepage } : {}),
      ...(script ? { script } : {}),
      ...(capabilities.length > 0 ? { capabilities } : {}),
      ...(schema ? { settings: schema } : {}),
      contributions,
      ...(collectors.length > 0 ? { collectors } : {}),
      ...(panelActions.length > 0 ? { panelActions } : {})
    }
  })
  return JSON.stringify(entries, null, 2)
}
