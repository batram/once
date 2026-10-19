import {
  LocaleMessages,
  WebExtensionManifest,
  localeCandidates,
  localizeManifestString,
  parseWebExtensionManifestJson
} from "@once/core"
import { asBytes, asText, toBase64 } from "./bytes"
import { ExtensionFileReader } from "./hostServices"
import { hostForExtensionId } from "./ExtensionScheme"

export const GENERATED_BACKGROUND_PAGE = "/_generated_background_page.html"

export interface LoadedExtension {
  readonly id: string
  readonly host: string
  /** Where the package is, in the host's own terms; shown and compared, never parsed here. */
  readonly directory: string
  readonly files: ExtensionFileReader
  readonly manifest: WebExtensionManifest
  /** The manifest as parsed JSON, handed back by `runtime.getManifest()`. */
  readonly rawManifest: unknown
  readonly messages: LocaleMessages
  readonly name: string
  readonly description: string
  /** Extension-relative path of the background document, if it has one. */
  readonly backgroundPage: string | null
}

/**
 * An extension-relative path with `.`/`..` segments resolved and no leading
 * slash, or null when it is empty or would leave the extension. Both slash
 * kinds separate, so no host can be talked into a different directory.
 */
export function extensionFilePath(relativePath: string): string | null {
  const segments: string[] = []
  for (const segment of relativePath.split(/[\\/]+/)) {
    if (segment === "" || segment === ".") continue
    if (segment === "..") {
      if (segments.length === 0) return null
      segments.pop()
      continue
    }
    segments.push(segment)
  }
  return segments.length === 0 ? null : segments.join("/")
}

/** A file of the extension as text; null when the path is outside it or missing. */
export function readExtensionText(extension: Pick<LoadedExtension, "files">, relativePath: string): string | null {
  const path = extensionFilePath(relativePath)
  const content = path === null ? null : extension.files.read(path)
  return content === null ? null : asText(content)
}

function readJson(files: ExtensionFileReader, path: string): unknown {
  const content = files.read(path)
  if (content === null) throw new Error(`${path} is missing`)
  return JSON.parse(asText(content))
}

function loadMessages(
  files: ExtensionFileReader,
  manifest: WebExtensionManifest,
  uiLanguage: string
): LocaleMessages {
  for (const locale of localeCandidates(uiLanguage, manifest.defaultLocale)) {
    try {
      return readJson(files, `_locales/${locale}/messages.json`) as LocaleMessages
    } catch {
      // Try the next, less specific locale.
    }
  }
  return {}
}

/** Reads an unpacked extension through the host's file access. */
export async function loadExtension(
  directory: string,
  files: ExtensionFileReader,
  uiLanguage: string
): Promise<LoadedExtension> {
  const manifestFile = files.read("manifest.json")
  if (manifestFile === null) throw new Error(`${directory} has no manifest.json`)
  const manifestText = asText(manifestFile)
  const manifest = parseWebExtensionManifestJson(manifestText)
  const messages = loadMessages(files, manifest, uiLanguage)
  const background = manifest.background
  return {
    id: manifest.id,
    host: hostForExtensionId(manifest.id),
    directory,
    files,
    manifest,
    rawManifest: JSON.parse(manifestText),
    messages,
    name: localizeManifestString(manifest.name, messages),
    description: localizeManifestString(manifest.description ?? "", messages),
    backgroundPage: background === null
      ? null
      : background.kind === "page"
        ? `/${background.page.replace(/^\/+/, "")}`
        : GENERATED_BACKGROUND_PAGE
  }
}

/** Firefox's equivalent for `background.scripts`: one script tag per entry. */
export function generatedBackgroundHtml(scripts: readonly string[], module = false): string {
  const type = module ? ' type="module"' : ""
  const tags = scripts
    .map((script) => `<script${type} src="${escapeAttribute(script)}"></script>`)
    .join("\n")
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body>\n${tags}\n</body></html>\n`
}

/**
 * The policy Firefox gives the extension's own pages: the manifest's
 * `content_security_policy` (MV2 string, MV3 `extension_pages`), else its
 * default. MV2 keeps WebAssembly for compatibility, as Firefox does.
 */
export function extensionPagePolicy(extension: Pick<LoadedExtension, "rawManifest">): string {
  const raw = (extension.rawManifest ?? {}) as { manifest_version?: unknown; content_security_policy?: unknown }
  const declared = raw.content_security_policy
  if (raw.manifest_version === 3) {
    const pages = typeof declared === "object" && declared !== null
      ? (declared as { extension_pages?: unknown }).extension_pages
      : undefined
    return typeof pages === "string" && pages.trim() ? pages : "script-src 'self'; upgrade-insecure-requests;"
  }
  return typeof declared === "string" && declared.trim()
    ? declared
    : "script-src 'self' 'wasm-unsafe-eval'; object-src 'self';"
}

function escapeAttribute(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;")
}

const MIME_TYPES: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml",
  ".wasm": "application/wasm",
  ".map": "application/json"
}

export function mimeTypeFor(file: string): string {
  const name = file.slice(Math.max(file.lastIndexOf("/"), file.lastIndexOf("\\")) + 1)
  const dot = name.lastIndexOf(".")
  const extension = dot > 0 ? name.slice(dot).toLowerCase() : ""
  return MIME_TYPES[extension] ?? "application/octet-stream"
}

/** Read an icon from the package without requiring a running extension host. */
export async function extensionIconDataUrl(extension: LoadedExtension): Promise<string | null> {
  const icons = { ...extension.manifest.icons, ...extension.manifest.browserAction?.defaultIcon }
  const sizes = Object.keys(icons).map(Number).filter(size => Number.isFinite(size) && size > 0)
  const preferred = sizes.filter(size => size <= 32).sort((a, b) => b - a)
  const size = preferred[0] ?? sizes.sort((a, b) => a - b)[0]
  const chosen = size !== undefined ? icons[String(size)] : icons.default
  const file = chosen ? extensionFilePath(chosen) : null
  if (!file) return null
  try {
    const body = extension.files.read(file)
    if (body === null) return null
    return `data:${mimeTypeFor(file)};base64,${toBase64(asBytes(body))}`
  } catch {
    return null
  }
}
