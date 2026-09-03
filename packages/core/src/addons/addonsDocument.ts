// The synced `addons` settings doc: the add-ons a user installed, each
// with its manifest and an enabled flag. Read tolerantly like every other
// settings doc; the text form is what the settings editor shows.

import { AddonManifest, AddonReport, readAddonManifest } from "./manifest"

export const ADDONS_DOCUMENT_ID = "addons"
export const ADDONS_VERSION = 1

export interface AddonEntry {
  enabled: boolean
  manifest: AddonManifest
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
    doc.addons.push({ enabled: entry.enabled !== false, manifest: read.manifest })
  }
  return doc
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
    const { enabled, ...manifest } = entry
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
    doc.addons.push({ enabled: enabled !== false, manifest: read.manifest })
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
  const entries = doc.addons.map(({ enabled, manifest }) => {
    const { protocol, id, name, version, author, homepage, script, contributions, collectors } = manifest
    return {
      ...(enabled ? {} : { enabled: false }),
      protocol, id, name, version,
      ...(author ? { author } : {}),
      ...(homepage ? { homepage } : {}),
      ...(script ? { script } : {}),
      contributions,
      ...(collectors.length > 0 ? { collectors } : {})
    }
  })
  return JSON.stringify(entries, null, 2)
}
