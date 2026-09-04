import { createHash } from "node:crypto"
import { existsSync, readFileSync, statSync, watch } from "node:fs"
import path from "node:path"

/**
 * Development add-ons: directories named in `ONCE_ADDONS` (PATH-style), each
 * holding `once-addon.json` and, when the manifest names one, its script.
 * Unpackaged builds only. Main reads them, pins the script by hash, and hands
 * manifest and code to the renderer, which registers them beside the synced
 * add-ons without ever writing them to the document; the script is served
 * over `once-addon://dev/<index>/<file>` so its URL is one the host owns.
 */
export interface DevAddon {
  directory: string
  /** The manifest as read, with `script` rewritten to a served URL and hash. */
  manifest: unknown
  /** The script's text, when the manifest named one that exists. */
  code: string | null
  /** Why the directory yielded nothing usable, when it did not. */
  error?: string
}

export function devAddonDirectories(configured: string | undefined): string[] {
  return (configured ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .map((entry) => path.resolve(entry))
}

const SCRIPT_FILE = /^[a-zA-Z0-9_.-]+\.(m?js)$/

/** The script file a manifest names: `"script": "main.js"` or `{ "file": "main.js" }`. */
function scriptFileOf(manifest: Record<string, unknown>): string | null {
  const script = manifest.script
  const file = typeof script === "string"
    ? script
    : typeof script === "object" && script !== null ? (script as { file?: unknown }).file : undefined
  if (typeof file !== "string") return null
  if (!SCRIPT_FILE.test(file)) throw new Error(`script file ${file} must be a plain .js name in the directory`)
  return file
}

export function readDevAddon(directory: string, index: number): DevAddon {
  const manifestPath = path.join(directory, "once-addon.json")
  try {
    if (!existsSync(manifestPath)) throw new Error("no once-addon.json")
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as unknown
    if (typeof manifest !== "object" || manifest === null || Array.isArray(manifest)) {
      throw new Error("once-addon.json must hold an object")
    }
    const record = { ...(manifest as Record<string, unknown>) }
    const file = scriptFileOf(record)
    if (!file) return { directory, manifest: record, code: null }
    const code = readFileSync(path.join(directory, file), "utf8")
    const integrity = `sha256-${createHash("sha256").update(code, "utf8").digest("base64")}`
    record.script = { url: `once-addon://dev/${index}/${file}`, integrity }
    return { directory, manifest: record, code }
  } catch (error) {
    return {
      directory,
      manifest: null,
      code: null,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}

export function readDevAddons(directories: readonly string[]): DevAddon[] {
  return directories.map((directory, index) => readDevAddon(directory, index))
}

/** The file a `once-addon://dev/<index>/<file>` URL names, or null when it is not one we serve. */
export function devAddonFile(directories: readonly string[], url: string): string | null {
  const parsed = new URL(url)
  if (parsed.host !== "dev") return null
  const [, indexText, file] = parsed.pathname.split("/")
  const index = Number(indexText)
  const directory = directories[index]
  if (!directory || !file || !SCRIPT_FILE.test(file) && file !== "once-addon.json") return null
  const resolved = path.join(directory, file)
  if (!resolved.startsWith(directory) || !existsSync(resolved) || !statSync(resolved).isFile()) return null
  return resolved
}

/** Runs `changed` (debounced) when anything in a directory changes; returns the stop function. */
export function watchDevAddons(directories: readonly string[], changed: () => void): () => void {
  let timer: NodeJS.Timeout | null = null
  const watchers = directories
    .filter((directory) => existsSync(directory))
    .map((directory) => watch(directory, () => {
      if (timer) clearTimeout(timer)
      timer = setTimeout(changed, 200)
    }))
  return () => {
    for (const watcher of watchers) watcher.close()
    if (timer) clearTimeout(timer)
  }
}
