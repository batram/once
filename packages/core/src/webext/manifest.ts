// The Firefox Manifest V2 and V3 subset the Once extension runtime
// understands. Parsing is strict about what the runtime relies on (id,
// version, script lists, match patterns) and lenient about keys it does not
// act on, so an extension that carries extra Firefox-only keys still loads.
// V3 differences are folded into the same shape: `action` becomes the
// browser action, `host_permissions` join the host list, a service worker
// becomes a background script and object-form web accessible resources
// flatten to their paths.

import { isMatchPattern } from "./matchPattern"

export type ManifestVersion = 2 | 3

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
  | {
    readonly kind: "scripts"
    readonly scripts: readonly string[]
    readonly persistent: boolean
    /** The scripts are ES modules (`background.type: "module"`). */
    readonly module: boolean
  }
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

/** One `declarative_net_request.rule_resources` entry: a JSON rule file. */
export interface StaticRulesetSpec {
  readonly id: string
  readonly enabled: boolean
  readonly path: string
}

/** The permissions that turn `declarativeNetRequest` on. */
const DNR_PERMISSIONS = ["declarativeNetRequest", "declarativeNetRequestWithHostAccess"]

export function hasDeclarativeNetRequest(manifest: WebExtensionManifest): boolean {
  return DNR_PERMISSIONS.some((permission) => manifest.permissions.has(permission))
}

export interface WebExtensionManifest {
  readonly manifestVersion: ManifestVersion
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
  /** Static `declarativeNetRequest` rulesets; empty without the manifest key. */
  readonly ruleResources: readonly StaticRulesetSpec[]
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

function background(json: Json, version: ManifestVersion): BackgroundSpec | null {
  const value = json.background
  if (value === undefined) return null
  if (!isObject(value)) throw new ManifestError('"background" must be an object')
  // A V3 background is an event page whatever the manifest says.
  const persistent = version === 2 && value.persistent !== false
  if (typeof value.page === "string") {
    return { kind: "page", page: value.page, persistent }
  }
  const module = value.type === "module"
  const scripts = stringList(value.scripts, '"background.scripts"')
  if (scripts.length > 0) return { kind: "scripts", scripts, persistent, module }
  // Firefox runs a V3 background as an event page and prefers `scripts`
  // when both are declared; a lone service worker is its script list.
  const worker = value.service_worker
  if (typeof worker === "string" && worker.length > 0) {
    return { kind: "scripts", scripts: [worker], persistent, module }
  }
  throw new ManifestError('"background" needs "scripts", "page" or "service_worker"')
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

// V3 renamed `browser_action` to `action`; the version's own key wins and
// the other is still read, so a manifest written for both keeps its button.
function browserAction(json: Json, version: ManifestVersion): BrowserActionSpec | null {
  const keys = version === 3 ? ["action", "browser_action"] : ["browser_action", "action"]
  const key = keys.find((candidate) => json[candidate] !== undefined)
  if (key === undefined) return null
  const value = json[key]
  if (!isObject(value)) throw new ManifestError(`"${key}" must be an object`)
  return {
    defaultTitle: optionalString(value, "default_title"),
    defaultPopup: optionalString(value, "default_popup"),
    defaultIcon: stringMap(value.default_icon, `"${key}.default_icon"`)
  }
}

// V3 lists resources as objects that also say which sites may load them.
// The protocol handler cannot tell who asks, so only the paths are kept.
function webAccessibleResources(value: unknown): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value)) throw new ManifestError('"web_accessible_resources" must be a list')
  const resources: string[] = []
  value.forEach((entry, index) => {
    const where = `"web_accessible_resources[${index}]"`
    if (typeof entry === "string") {
      resources.push(entry)
    } else if (isObject(entry)) {
      resources.push(...stringList(entry.resources, `${where}.resources`))
    } else {
      throw new ManifestError(`${where} must be a string or an object`)
    }
  })
  return resources
}

// Ruleset ids are what `updateEnabledRulesets` names; the browsers reserve
// the `_` prefix for the dynamic and session sets.
function ruleResources(json: Json): StaticRulesetSpec[] {
  const value = json.declarative_net_request
  if (value === undefined) return []
  if (!isObject(value)) throw new ManifestError('"declarative_net_request" must be an object')
  const resources = value.rule_resources
  if (!Array.isArray(resources)) {
    throw new ManifestError('"declarative_net_request.rule_resources" must be a list')
  }
  const ids = new Set<string>()
  return resources.map((entry, index) => {
    const where = `"declarative_net_request.rule_resources[${index}]"`
    if (!isObject(entry)) throw new ManifestError(`${where} must be an object`)
    const id = requireString(entry, "id")
    if (id.startsWith("_") || ids.has(id)) throw new ManifestError(`${where} has an invalid or duplicate id "${id}"`)
    ids.add(id)
    if (typeof entry.enabled !== "boolean") throw new ManifestError(`${where}.enabled must be a boolean`)
    return { id, enabled: entry.enabled, path: requireString(entry, "path") }
  })
}

function manifestVersion(value: unknown): ManifestVersion {
  if (value === 2 || value === 3) return value
  throw new ManifestError("only manifest_version 2 and 3 are supported")
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
  const version = manifestVersion(input.manifest_version)

  // V2 mixes host patterns into `permissions`; V3 has `host_permissions`.
  // Both are read for both versions, so a hybrid manifest loses nothing.
  const permissions = new Set<string>()
  const hostPermissions = new Set<string>()
  for (const entry of stringList(input.permissions, '"permissions"')) {
    if (isMatchPattern(entry)) hostPermissions.add(entry)
    else permissions.add(entry)
  }
  for (const entry of stringList(input.host_permissions, '"host_permissions"')) {
    if (!isMatchPattern(entry)) {
      throw new ManifestError(`"host_permissions" has an invalid match pattern "${entry}"`)
    }
    hostPermissions.add(entry)
  }

  return {
    manifestVersion: version,
    id: extensionId(input),
    name: requireString(input, "name"),
    version: requireString(input, "version"),
    description: optionalString(input, "description"),
    defaultLocale: optionalString(input, "default_locale"),
    background: background(input, version),
    contentScripts: contentScripts(input),
    permissions,
    hostPermissions: [...hostPermissions],
    browserAction: browserAction(input, version),
    optionsUi: optionsUi(input),
    webAccessibleResources: webAccessibleResources(input.web_accessible_resources),
    icons: stringMap(input.icons, '"icons"'),
    ruleResources: ruleResources(input)
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
