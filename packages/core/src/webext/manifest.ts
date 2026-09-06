// The Firefox Manifest V2 subset the Once extension runtime understands.
// Parsing is strict about what the runtime relies on (id, version, script
// lists, match patterns) and lenient about keys it does not act on, so an
// extension that carries extra Firefox-only keys still loads.

import { isMatchPattern } from "./matchPattern"

export type ContentScriptRunAt = "document_start" | "document_end" | "document_idle"

export interface ContentScriptSpec {
  readonly world?: "MAIN" | "ISOLATED"
  readonly matches: readonly string[]
  readonly excludeMatches: readonly string[]
  readonly js: readonly string[]
  readonly css: readonly string[]
  readonly runAt: ContentScriptRunAt
  readonly allFrames: boolean
  readonly matchAboutBlank: boolean
}

export type BackgroundSpec =
  | { readonly kind: "scripts"; readonly scripts: readonly string[]; readonly persistent: boolean }
  | { readonly kind: "page"; readonly page: string; readonly persistent: boolean }

export interface BrowserActionSpec {
  readonly defaultTitle: string | null
  readonly defaultPopup: string | null
  readonly defaultIcon: Readonly<Record<string, string>>
}

export interface OptionsUiSpec {
  readonly page: string
  readonly openInTab: boolean
}

export interface WebExtensionManifest {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly description: string | null
  readonly defaultLocale: string | null
  readonly background: BackgroundSpec | null
  readonly contentScripts: readonly ContentScriptSpec[]
  /** API permissions such as `webRequest`, `storage`, `tabs`. */
  readonly permissions: ReadonlySet<string>
  /** Host permissions as match patterns, including `<all_urls>`. */
  readonly hostPermissions: readonly string[]
  readonly browserAction: BrowserActionSpec | null
  readonly optionsUi: OptionsUiSpec | null
  readonly webAccessibleResources: readonly string[]
  readonly icons: Readonly<Record<string, string>>
}

export class ManifestError extends Error {
  constructor(reason: string) {
    super(`Invalid extension manifest: ${reason}`)
    this.name = "ManifestError"
  }
}

type Json = Record<string, unknown>

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function requireString(json: Json, key: string): string {
  const value = json[key]
  if (typeof value !== "string" || value.length === 0) {
    throw new ManifestError(`"${key}" must be a non-empty string`)
  }
  return value
}

function optionalString(json: Json, key: string): string | null {
  const value = json[key]
  if (value === undefined || value === null) return null
  if (typeof value !== "string") throw new ManifestError(`"${key}" must be a string`)
  return value
}

function stringList(value: unknown, where: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ManifestError(`${where} must be a list of strings`)
  }
  return value
}

function stringMap(value: unknown, where: string): Record<string, string> {
  if (value === undefined) return {}
  if (typeof value === "string") return { default: value }
  if (!isObject(value)) throw new ManifestError(`${where} must be an object`)
  const result: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== "string") throw new ManifestError(`${where}.${key} must be a string`)
    result[key] = entry
  }
  return result
}

function extensionId(json: Json): string {
  for (const key of ["browser_specific_settings", "applications"]) {
    const settings = json[key]
    if (!isObject(settings)) continue
    const gecko = settings.gecko
    if (isObject(gecko) && typeof gecko.id === "string" && gecko.id.length > 0) {
      return gecko.id
    }
  }
  throw new ManifestError(
    "a Firefox extension id is required (browser_specific_settings.gecko.id)"
  )
}

function background(json: Json): BackgroundSpec | null {
  const value = json.background
  if (value === undefined) return null
  if (!isObject(value)) throw new ManifestError('"background" must be an object')
  const persistent = value.persistent !== false
  if (typeof value.page === "string") {
    return { kind: "page", page: value.page, persistent }
  }
  const scripts = stringList(value.scripts, '"background.scripts"')
  if (scripts.length === 0) {
    throw new ManifestError('"background" needs "scripts" or "page"')
  }
  return { kind: "scripts", scripts, persistent }
}

const RUN_AT: ReadonlySet<string> = new Set(["document_start", "document_end", "document_idle"])

function contentScripts(json: Json): ContentScriptSpec[] {
  const value = json.content_scripts
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ManifestError('"content_scripts" must be a list')
  return value.map((entry, index) => {
    const where = `"content_scripts[${index}]"`
    if (!isObject(entry)) throw new ManifestError(`${where} must be an object`)
    const matches = stringList(entry.matches, `${where}.matches`)
    if (matches.length === 0) throw new ManifestError(`${where}.matches must not be empty`)
    const excludeMatches = stringList(entry.exclude_matches, `${where}.exclude_matches`)
    for (const pattern of [...matches, ...excludeMatches]) {
      if (!isMatchPattern(pattern)) {
        throw new ManifestError(`${where} has an invalid match pattern "${pattern}"`)
      }
    }
    const js = stringList(entry.js, `${where}.js`)
    const css = stringList(entry.css, `${where}.css`)
    if (js.length === 0 && css.length === 0) {
      throw new ManifestError(`${where} needs "js" or "css"`)
    }
    const runAt = entry.run_at ?? "document_idle"
    if (typeof runAt !== "string" || !RUN_AT.has(runAt)) {
      throw new ManifestError(`${where}.run_at is not a known value`)
    }
    return {
      ...(entry.world === "MAIN" ? { world: "MAIN" as const } : {}),
      matches,
      excludeMatches,
      js,
      css,
      runAt: runAt as ContentScriptRunAt,
      allFrames: entry.all_frames === true,
      matchAboutBlank: entry.match_about_blank === true
    }
  })
}

function browserAction(json: Json): BrowserActionSpec | null {
  const value = json.browser_action
  if (value === undefined) return null
  if (!isObject(value)) throw new ManifestError('"browser_action" must be an object')
  return {
    defaultTitle: optionalString(value, "default_title"),
    defaultPopup: optionalString(value, "default_popup"),
    defaultIcon: stringMap(value.default_icon, '"browser_action.default_icon"')
  }
}

function optionsUi(json: Json): OptionsUiSpec | null {
  const value = json.options_ui
  if (value === undefined) return typeof json.options_page === "string" ? { page: json.options_page, openInTab: true } : null
  if (!isObject(value)) throw new ManifestError('"options_ui" must be an object')
  return {
    page: requireString(value, "page"),
    openInTab: value.open_in_tab === true
  }
}

export function parseWebExtensionManifest(input: unknown): WebExtensionManifest {
  if (!isObject(input)) throw new ManifestError("manifest must be an object")
  if (input.manifest_version !== 2) {
    throw new ManifestError("only manifest_version 2 is supported")
  }

  const permissions = new Set<string>()
  const hostPermissions: string[] = []
  for (const entry of stringList(input.permissions, '"permissions"')) {
    if (isMatchPattern(entry)) hostPermissions.push(entry)
    else permissions.add(entry)
  }

  return {
    id: extensionId(input),
    name: requireString(input, "name"),
    version: requireString(input, "version"),
    description: optionalString(input, "description"),
    defaultLocale: optionalString(input, "default_locale"),
    background: background(input),
    contentScripts: contentScripts(input),
    permissions,
    hostPermissions,
    browserAction: browserAction(input),
    optionsUi: optionsUi(input),
    webAccessibleResources: stringList(
      input.web_accessible_resources,
      '"web_accessible_resources"'
    ),
    icons: stringMap(input.icons, '"icons"')
  }
}

export function parseWebExtensionManifestJson(text: string): WebExtensionManifest {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new ManifestError(`manifest.json is not valid JSON (${detail})`)
  }
  return parseWebExtensionManifest(parsed)
}
