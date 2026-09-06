import { AddonEntry, readAddonManifest, SANDBOX_LIMITS } from "@once/core"

const MAX_FILES = 256
const MAX_PACKAGE = 8 * 1024 * 1024
const MAX_MANIFEST = 256 * 1024
export interface LocalAddonPackage { entry: AddonEntry; code: string | null }
interface PackageFile { name: string; size: number; text(limit: number): Promise<string> }

function safePath(name: string): string {
  if (!name || name.length > 500 || /[\\:]/.test(name) || Array.from(name).some(char => char.charCodeAt(0) < 32) || name.split("/").some(part => !part || part === "." || part === "..")) {
    throw new Error("Package contains an unsafe file path")
  }
  return name
}

async function readPackage(files: PackageFile[]): Promise<LocalAddonPackage> {
  if (files.length > MAX_FILES || files.reduce((size, file) => size + file.size, 0) > MAX_PACKAGE) throw new Error("Addon package is too large (8 MiB / 256 files maximum)")
  const byName = new Map<string, PackageFile>()
  for (const file of files) {
    const name = safePath(file.name)
    if (byName.has(name)) throw new Error("Package contains duplicate file paths")
    byName.set(name, file)
  }
  const manifests = files.filter(file => file.name.split("/").at(-1) === "once-addon.json")
  if (manifests.length !== 1) throw new Error("Choose a package containing exactly one once-addon.json")
  const file = manifests[0]
  if (file.size > MAX_MANIFEST) throw new Error("Addon manifest is too large")
  const raw: unknown = JSON.parse(await file.text(MAX_MANIFEST))
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("Addon manifest must be an object")
  const manifest = { ...raw } as Record<string, unknown>
  let code: string | null = null
  if (manifest.script != null) {
    const script = manifest.script
    const descriptor = typeof script === "object" ? script as Record<string, unknown> : {}
    const relative = typeof script === "string" ? script : descriptor.file ?? descriptor.url
    if (typeof relative !== "string") throw new Error("Local packages must name a script file inside the package")
    const name = safePath(relative)
    if (!/\.m?js$/i.test(name)) throw new Error("The addon script must be a .js or .mjs file")
    const prefix = file.name.slice(0, -"once-addon.json".length)
    const source = byName.get(prefix + name)
    if (!source) throw new Error(`Package is missing its script: ${name}`)
    if (source.size > SANDBOX_LIMITS.code) throw new Error("The addon script is too large")
    code = await source.text(SANDBOX_LIMITS.code)
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(code)))
    const integrity = `sha256-${btoa(String.fromCharCode(...digest))}`
    if (descriptor.integrity !== undefined && descriptor.integrity !== integrity) throw new Error("Script integrity does not match the manifest")
    const key = Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")
    manifest.script = { url: `once-addon://local/${key}/main.js`, integrity }
  }
  const read = readAddonManifest(manifest)
  if (!read.ok) throw new Error(read.reports.map(report => `${report.path} ${report.message}`).join("; "))
  return { entry: { enabled: true, manifest: read.manifest }, code }
}

/** Snapshot only: browser folder pickers grant files, not a persistent watched path. */
export function readAddonFolder(files: readonly File[]): Promise<LocalAddonPackage> {
  return readPackage(files.map(file => ({ name: file.webkitRelativePath || file.name, size: file.size, text: async limit => {
    if (file.size > limit) throw new Error("Package file is too large")
    return file.text()
  } })))
}

/** Read selected entries in memory; no paths from an archive are extracted to disk. */
export async function readAddonZip(blob: Blob): Promise<LocalAddonPackage> {
  if (blob.size > MAX_PACKAGE) throw new Error("ZIP file is too large (8 MiB maximum)")
  const { ZipReader, BlobReader } = await import("@zip.js/zip.js/index-native.js")
  const reader = new ZipReader(new BlobReader(blob), { useWebWorkers: false, useCompressionStream: true })
  const files: PackageFile[] = []
  let count = 0
  try {
    for await (const entry of reader.getEntriesGenerator()) {
      if (++count > MAX_FILES) throw new Error("ZIP contains too many entries (256 maximum)")
      safePath(entry.directory ? entry.filename.replace(/\/$/, "") : entry.filename)
      if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error("ZIP symbolic links are not supported")
      if (entry.encrypted) throw new Error("Encrypted ZIP files are not supported")
      if (entry.directory) continue
      files.push({ name: entry.filename, size: entry.uncompressedSize, text: async limit => {
        let size = 0
        const chunks: Uint8Array[] = []
        await entry.getData(new WritableStream<Uint8Array>({ write(chunk) {
          size += chunk.byteLength
          if (size > limit) throw new Error("Decompressed addon file is too large")
          chunks.push(chunk)
        } }), { checkSignature: true, useWebWorkers: false, useCompressionStream: true })
        const bytes = new Uint8Array(size)
        let offset = 0
        for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length }
        return new TextDecoder("utf-8", { fatal: true }).decode(bytes)
      } })
    }
    return await readPackage(files)
  } finally { await reader.close() }
}
