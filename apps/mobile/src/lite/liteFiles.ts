// Extension files reach the broker two ways. The general path is the
// synchronous `window.onceLiteFiles.read(directory, path)` JavascriptInterface
// (`addJavascriptInterface`; sync string return: a JSON `{"text"}` or
// `{"base64"}` document, or `null`), because `ExtensionFileReader.read` must
// answer synchronously. On top of it `preload` asks Java once per load for
// the files every frame will need (manifest, locales, content scripts, the
// web-accessible list) so matching and serving never block on the interface
// for those. The built bundles come through the same interface under the
// `@bundle` pseudo directory.

import { ExtensionFileReader } from "@once/webext-runtime"
import { BUNDLE_DIRECTORY } from "./protocol"

/** The Java object; `read` is synchronous. */
export interface FilesInterface {
  read(directory: string, path: string): string | null
  /** Unpacks a base64 archive into the staging directory named by token; answers the entry list as JSON. */
  unzip?(token: string, archiveBase64: string): string
  /**
   * Store documents too large for one message: `writeChunk` appends UTF-8 text
   * to the pending value named by `token` (a `store.write`/`store.patch` then
   * names it as `{chunked: token}`); `readChunk` answers the next piece of a
   * `store.read` that came back `chunked`, as JSON `{"text", "done"}`.
   */
  writeChunk?(token: string, text: string): string
  readChunk?(token: string, maxBytes: number): string
}

export type PreloadedFiles = Readonly<Record<string, { text?: string; base64?: string }>>

function decodeBase64(base64: string): Uint8Array {
  const binary = atob(base64)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return bytes
}

function decodeEntry(entry: { text?: string; base64?: string } | null): string | Uint8Array | null {
  if (!entry) return null
  if (typeof entry.text === "string") return entry.text
  if (typeof entry.base64 === "string") return decodeBase64(entry.base64)
  return null
}

export class LiteFileReader implements ExtensionFileReader {
  private readonly cache = new Map<string, string | Uint8Array | null>()

  constructor(
    private readonly files: FilesInterface,
    readonly directory: string,
    preloaded: PreloadedFiles = {}
  ) {
    for (const [path, entry] of Object.entries(preloaded)) this.cache.set(path, decodeEntry(entry))
  }

  read(relativePath: string): string | Uint8Array | null {
    const cached = this.cache.get(relativePath)
    if (cached !== undefined) return cached
    let raw: string | null
    try {
      raw = this.files.read(this.directory, relativePath)
    } catch {
      raw = null
    }
    const value = raw === null ? null : decodeEntry(JSON.parse(raw))
    // Text files are small and read again by every frame; bytes are not kept.
    if (typeof value === "string" || value === null) this.cache.set(relativePath, value)
    return value
  }
}

/** A built bundle (`lite-world-bootstrap.js`, `lite-page-bootstrap.js`) as text. */
export function readBundle(files: FilesInterface, name: string): string {
  const raw = files.read(BUNDLE_DIRECTORY, name)
  const value = raw === null ? null : decodeEntry(JSON.parse(raw))
  if (typeof value !== "string") throw new Error(`Bundle ${name} is not available`)
  return value
}

export { decodeBase64 }
