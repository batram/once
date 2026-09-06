import { createHash, randomUUID } from "node:crypto"
import { promises as fs } from "node:fs"
import path from "node:path"
import { app, net } from "electron"
import AdmZip from "adm-zip"
import { LoadedExtension, loadUnpackedExtension } from "./LoadedExtension"

const MAX_ARCHIVE = 32 * 1024 * 1024
const MAX_EXPANDED = 128 * 1024 * 1024

export interface ExtensionCandidate {
  token: string
  extension: LoadedExtension
  source: string
  sha256: string
}

export function amoSlug(source: string): string {
  const url = new URL(source)
  const slug = url.pathname.match(/^\/(?:[a-zA-Z-]+\/)?firefox\/addon\/([^/]+)\/?$/)?.[1]
  if (url.protocol !== "https:" || url.hostname !== "addons.mozilla.org" || url.username || url.password || !slug) {
    throw new Error("Use a Firefox Add-ons page URL, or choose an XPI file.")
  }
  return decodeURIComponent(slug)
}

async function download(url: string, limit: number, redirects = 0): Promise<Buffer> {
  const parsed = new URL(url)
  if (parsed.protocol !== "https:" || parsed.username || parsed.password ||
      !["addons.mozilla.org", "addons.cdn.mozilla.net"].includes(parsed.hostname)) {
    throw new Error("The download must come from Mozilla Add-ons.")
  }
  const response = await net.fetch(url, { credentials: "omit", redirect: "manual", signal: AbortSignal.timeout(60_000) })
  if ([301, 302, 303, 307, 308].includes(response.status)) {
    await response.body?.cancel()
    const location = response.headers.get("location")
    if (!location || redirects >= 5) throw new Error("Extension download has too many redirects")
    return download(new URL(location, url).href, limit, redirects + 1)
  }
  if (!response.ok || !response.body) throw new Error(`Extension download failed: HTTP ${response.status}`)
  const chunks: Buffer[] = []
  let size = 0
  const reader = response.body.getReader()
  try {
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.length
      if (size > limit) throw new Error("Extension download exceeds the size limit")
      chunks.push(Buffer.from(value))
    }
  } finally { await reader.cancel() }
  return Buffer.concat(chunks)
}

/** Validate every archive path and size before writing any files. */
export async function unpackExtension(data: Buffer, directory: string): Promise<void> {
  if (data.length > MAX_ARCHIVE) throw new Error("XPI exceeds the 32 MB limit")
  const entries = new AdmZip(data).getEntries()
  const names = new Set<string>()
  let expanded = 0
  if (entries.length > 10000) throw new Error("XPI has too many files")
  for (const entry of entries) {
    const name = entry.entryName.replace(/\/$/, "")
    if (!name || name.split("/").some(part => !part || part === "." || part === ".." ||
        /[\\:]/.test(part) || [...part].some(char => char.charCodeAt(0) < 32) || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part)) ||
        names.has(name.toLowerCase())) throw new Error("XPI contains an unsafe or duplicate file path")
    names.add(name.toLowerCase())
    expanded += entry.header.size
    if (expanded > MAX_EXPANDED) throw new Error("Expanded XPI exceeds the 128 MB limit")
  }
  for (const entry of entries) {
    const file = path.join(directory, entry.entryName)
    if (entry.isDirectory) { await fs.mkdir(file, { recursive: true }); continue }
    const body = entry.getData()
    if (body.length !== entry.header.size) throw new Error("XPI file size mismatch")
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, body, { flag: "wx" })
  }
}

export async function prepareExtension(root: string, source: string, localFile?: string): Promise<ExtensionCandidate> {
  let archive: Buffer
  let expectedId: string | undefined
  let expectedHash: string | undefined
  if (localFile) {
    if ((await fs.stat(localFile)).size > MAX_ARCHIVE) throw new Error("XPI exceeds the 32 MB limit")
    archive = await fs.readFile(localFile)
  } else {
    const metadata = JSON.parse((await download(
      `https://addons.mozilla.org/api/v5/addons/addon/${encodeURIComponent(amoSlug(source))}/`, 2 * 1024 * 1024
    )).toString("utf8"))
    const file = metadata.current_version?.file
    if (metadata.type !== "extension" || !file?.url || !/^sha256:[a-f0-9]{64}$/.test(file.hash)) {
      throw new Error("Mozilla did not return a downloadable extension with a SHA-256 hash")
    }
    expectedId = metadata.guid
    expectedHash = file.hash.slice(7)
    archive = await download(file.url, MAX_ARCHIVE)
  }
  const sha256 = createHash("sha256").update(archive).digest("hex")
  if (expectedHash && sha256 !== expectedHash) throw new Error("XPI does not match Mozilla's published hash")
  const token = randomUUID()
  const directory = path.join(root, "packages", token)
  try {
    await unpackExtension(archive, directory)
    const extension = await loadUnpackedExtension(directory, app.getLocale())
    if (expectedId && extension.id !== expectedId) throw new Error("XPI identity does not match Mozilla's listing")
    return { token, extension, source: localFile ? "Local XPI (signature not verified)" : source, sha256 }
  } catch (error) {
    await fs.rm(directory, { recursive: true, force: true })
    throw error
  }
}
