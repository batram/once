// From a Mozilla Add-ons listing, an XPI link or a local file to an unpacked,
// validated package. The host supplies the network, the hash, the unzipper
// and the package directory (`ExtensionPackageHost`); the rules about what
// is accepted live here; constrained transports may impose lower size limits.

import { LoadedExtension, loadExtension } from "./LoadedExtension"
import { ArchiveEntry, ExtensionPackageHost } from "./hostServices"

// AMO uses decimal MB for uploads and binary MiB for expanded files.
export const MAX_ARCHIVE_BYTES = 200_000_000
const MAX_EXPANDED = 250 * 1024 * 1024
const MAX_FILE_BYTES = 100 * 1024 * 1024

function archiveLimit(host: ExtensionPackageHost): number {
  return Math.min(host.maxArchiveBytes ?? MAX_ARCHIVE_BYTES, MAX_ARCHIVE_BYTES)
}

function checkArchiveSize(size: number, limit = MAX_ARCHIVE_BYTES): void {
  if (size > limit) throw new Error(`XPI exceeds the ${limit === MAX_ARCHIVE_BYTES ? "200 MB" : `${limit / 1024 / 1024} MiB`} limit`)
}

export interface ExtensionCandidate {
  token: string
  extension: LoadedExtension
  source: string
  sha256: string
}

const AMO_PAGE_PATH = /^\/(?:[a-zA-Z-]+\/)?firefox\/addon\/([^/]+)\/?$/
const AMO_DOWNLOAD_PATH = /^\/(?:[a-zA-Z-]+\/)?firefox\/downloads\/file\/\d+\/[^/]+\.xpi$/i
const AMO_HOSTS = ["addons.mozilla.org", "addons.cdn.mozilla.net"]

/** An add-on's listing page, one of its XPI download links, or neither. */
export function amoSourceKind(source: string): "page" | "download" | null {
  let url: URL
  try { url = new URL(source) } catch { return null }
  if (url.protocol !== "https:" || url.username || url.password) return null
  if (url.hostname === "addons.mozilla.org" && AMO_PAGE_PATH.test(url.pathname)) return "page"
  if (AMO_HOSTS.includes(url.hostname) && AMO_DOWNLOAD_PATH.test(url.pathname)) return "download"
  return null
}

export function amoSlug(source: string): string {
  if (amoSourceKind(source) !== "page") throw new Error("Use a Firefox Add-ons page URL, or choose an XPI file.")
  return decodeURIComponent(new URL(source).pathname.match(AMO_PAGE_PATH)?.[1] ?? "")
}

interface Listing {
  guid: string
  hash: string
  url: string
}

/** Mozilla's current file for an add-on, by listing slug or by Gecko id. */
async function listing(host: ExtensionPackageHost, key: string): Promise<Listing> {
  const body = await download(host, `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(key)}/`, 2 * 1024 * 1024)
  const metadata = JSON.parse(new TextDecoder().decode(body))
  const file = metadata.current_version?.file
  if (metadata.type !== "extension" || !file?.url || !/^sha256:[a-f0-9]{64}$/.test(file.hash)) {
    throw new Error("Mozilla did not return a downloadable extension with a SHA-256 hash")
  }
  return { guid: metadata.guid, hash: file.hash.slice(7), url: file.url }
}

async function download(host: ExtensionPackageHost, url: string, limit: number, redirects = 0): Promise<Uint8Array> {
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || !AMO_HOSTS.includes(parsed.hostname)) {
    throw new Error("The download must come from Mozilla Add-ons.")
  }
  const response = await host.fetch(url, { credentials: "omit", redirect: "manual", signal: AbortSignal.timeout(60_000) })
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel()
    const location = response.headers.get("location")
    if (!location || redirects >= 5) throw new Error("Extension download has too many redirects")
    return download(host, new URL(location, url).href, limit, redirects + 1)
  }
  if (!response.ok || !response.body) throw new Error(`Extension download failed: HTTP ${response.status}`)
  if (Number(response.headers.get("content-length")) > limit) {
    await response.body.cancel()
    throw new Error("Extension download exceeds the size limit")
  }
  const chunks: Uint8Array[] = []
  let size = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw new Error("Extension download exceeds the size limit")
      chunks.push(value)
    }
  } finally { await reader.cancel() }
  const joined = new Uint8Array(size)
  let offset = 0
  for (const chunk of chunks) {
    joined.set(chunk, offset)
    offset += chunk.length
  }
  return joined
}

const UNSAFE_NAME = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i

function unsafeSegment(part: string): boolean {
  return !part || part === "." || part === ".." || /[\\:]/.test(part) ||
    [...part].some(char => char.charCodeAt(0) < 32) || /[. ]$/.test(part) || UNSAFE_NAME.test(part)
}

/** Every archive path and size, checked as a whole before anything is written. */
export function validateArchiveEntries(archive: Uint8Array, entries: readonly ArchiveEntry[], maxExpandedBytes = MAX_EXPANDED): void {
  checkArchiveSize(archive.length)
  const names = new Set<string>()
  let expanded = 0
  if (entries.length > 10000) throw new Error("XPI has too many files")
  for (const entry of entries) {
    const name = entry.name.replace(/\/$/, "")
    if (!name || name.split("/").some(unsafeSegment) || names.has(name.toLowerCase())) {
      throw new Error("XPI contains an unsafe or duplicate file path")
    }
    names.add(name.toLowerCase())
    if (entry.size > MAX_FILE_BYTES) throw new Error("XPI file exceeds the 100 MiB limit")
    expanded += entry.size
    if (expanded >= Math.min(maxExpandedBytes, MAX_EXPANDED)) throw new Error(`Expanded XPI must be smaller than ${Math.min(maxExpandedBytes, MAX_EXPANDED) / 1024 / 1024} MiB`)
  }
}

/** Validates, then writes the archive into `directory` through the host's package store. */
export async function unpackExtension(host: ExtensionPackageHost, archive: Uint8Array, directory: string): Promise<void> {
  checkArchiveSize(archive.length, archiveLimit(host))
  const entries = host.unzip(archive)
  validateArchiveEntries(archive, entries, host.maxExpandedBytes)
  for (const entry of entries) {
    if (entry.isDirectory) { await host.packages.mkdir(directory, entry.name); continue }
    const body = entry.data()
    if (body.length !== entry.size) throw new Error("XPI file size mismatch")
    await host.packages.writeFile(directory, entry.name, body)
  }
}

export async function prepareExtension(host: ExtensionPackageHost, source: string, localFile?: string): Promise<ExtensionCandidate> {
  let archive: Uint8Array
  let expected: Listing | undefined
  // A direct XPI link carries no listing: the package names its id, and
  // Mozilla's listing for that id must then vouch for exactly this file.
  const direct = !localFile && amoSourceKind(source) === "download"
  if (localFile) {
    archive = await host.readArchive(localFile)
    checkArchiveSize(archive.length, archiveLimit(host))
  } else if (direct) {
    archive = await download(host, source, archiveLimit(host))
  } else {
    expected = await listing(host, amoSlug(source))
    archive = await download(host, expected.url, archiveLimit(host))
  }
  const sha256 = await host.sha256(archive)
  if (expected && sha256 !== expected.hash) throw new Error("XPI does not match Mozilla's published hash")
  const token = crypto.randomUUID()
  const directory = host.packages.directory(token)
  try {
    await unpackExtension(host, archive, directory)
    const extension = await loadExtension(directory, host.packages.reader(directory), host.locale())
    if (direct) {
      expected = await listing(host, extension.id)
      if (sha256 !== expected.hash) throw new Error("XPI is not the version Mozilla currently lists for this extension")
    }
    if (expected && extension.id !== expected.guid) throw new Error("XPI identity does not match Mozilla's listing")
    return { token, extension, source: localFile ? "Local XPI (signature not verified)" : source, sha256 }
  } catch (error) {
    await host.packages.remove(directory)
    throw error
  }
}
