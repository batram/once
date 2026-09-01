import { promises as fs } from "node:fs"
import path from "node:path"
import {
  LocaleMessages,
  WebExtensionManifest,
  localeCandidates,
  localizeManifestString,
  parseWebExtensionManifestJson
} from "@once/core"
import { hostForExtensionId } from "./ExtensionScheme"

export const GENERATED_BACKGROUND_PAGE = "/_generated_background_page.html"

export interface LoadedExtension {
  readonly id: string
  readonly host: string
  readonly directory: string
  readonly manifest: WebExtensionManifest
  /** The manifest as parsed JSON, handed back by `runtime.getManifest()`. */
  readonly rawManifest: unknown
  readonly messages: LocaleMessages
  readonly name: string
  readonly description: string
  /** Extension-relative path of the background document, if it has one. */
  readonly backgroundPage: string | null
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"))
}

async function loadMessages(
  directory: string,
  manifest: WebExtensionManifest,
  uiLanguage: string
): Promise<LocaleMessages> {
  for (const locale of localeCandidates(uiLanguage, manifest.defaultLocale)) {
    const file = path.join(directory, "_locales", locale, "messages.json")
    try {
      return (await readJson(file)) as LocaleMessages
    } catch {
      // Try the next, less specific locale.
    }
  }
  return {}
}

export async function loadUnpackedExtension(
  directory: string,
  uiLanguage: string
): Promise<LoadedExtension> {
  const resolved = path.resolve(directory)
  const manifestText = await fs.readFile(path.join(resolved, "manifest.json"), "utf8")
  const manifest = parseWebExtensionManifestJson(manifestText)
  const messages = await loadMessages(resolved, manifest, uiLanguage)
  const background = manifest.background
  return {
    id: manifest.id,
    host: hostForExtensionId(manifest.id),
    directory: resolved,
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

/**
 * The absolute file for an extension-relative path, or null when the path
 * would leave the extension directory. Existence is the caller's question.
 */
export function resolveExtensionFile(
  extension: LoadedExtension,
  relativePath: string
): string | null {
  const trimmed = relativePath.replace(/^\/+/, "")
  if (trimmed.length === 0) return null
  const absolute = path.resolve(extension.directory, trimmed)
  const root = extension.directory.endsWith(path.sep)
    ? extension.directory
    : `${extension.directory}${path.sep}`
  return absolute.startsWith(root) ? absolute : null
}

/** Firefox's equivalent for `background.scripts`: one script tag per entry. */
export function generatedBackgroundHtml(scripts: readonly string[]): string {
  const tags = scripts
    .map((script) => `<script src="${escapeAttribute(script)}"></script>`)
    .join("\n")
  return `<!DOCTYPE html>\n<html><head><meta charset="utf-8"></head><body>\n${tags}\n</body></html>\n`
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
  return MIME_TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream"
}
