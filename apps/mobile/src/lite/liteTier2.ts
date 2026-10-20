// Tier 2 of Once Lite (docs/plans/once-lite-plan.md): the WebView without a
// usable DevTools connection. No full extension runs; the broker still owns
// the decisions and compiles them for Java, which applies them without a
// round trip per request:
//
// - `net.rules {groups}`: the DNR rules Java's evaluator enforces from
//   `shouldInterceptRequest`. One group for uBlock Origin Lite (its enabled
//   static rulesets by path, read by Java from the package, plus the session
//   rules set through `net.sessionRules`), one for Once's synced filter
//   lists converted through the portable subset (`liteFilterLists.ts`).
// - `tier2.scripts {sources}`: the page-world sources Java registers on every
//   reading tab at document start: the lists' generic cosmetics, uBO Lite's
//   generic cosmetic filtering (its own `css-generic.js` over its
//   per-ruleset selector maps, with `cssAPI` inserting `<style>` elements),
//   and the synced userscripts (`lite-tier2-page.js` once, then one source
//   per script, see `tier2Page.ts`).
//
// The catalogue lists the bundled uBlock Origin and Violentmonkey, and any
// installed extension, as disabled with the Tier 2 reason, and uBO Lite as
// the enabled one. `settings.apply` answers once Java has both documents in
// force, which is what the first navigation waits for.

import { DnrRule, parseDnrRule, parseUserscript } from "@once/core"
import { ExtensionSettings, extensionIconDataUrl, loadExtension } from "@once/webext-runtime"
import { JavaChannel, RequestError } from "./javaChannel"
import { FilesInterface, LiteFileReader } from "./liteFiles"
import { cosmeticCss, filterListRules, parseFilterList, ParsedFilterList } from "./liteFilterLists"
import {
  BundledExtensionParam,
  CatalogEntry,
  NetRuleGroup,
  NetRulesParams,
  NetRulesResult,
  SessionRulesParams,
  TIER2_DISABLED_REASON,
  Tier2FetchListResult,
  Tier2ScriptsParams,
  UBOLITE_ID
} from "./protocol"
import { Tier2ScriptInfo } from "./tier2Page"

export const UBOLITE_GROUP = "ubolite"
export const LISTS_GROUP = "once-lists"
const MAX_SESSION_RULES = 5000

interface Manifest {
  name?: string
  version?: string
  description?: string
  default_locale?: string
  icons?: Record<string, string>
  permissions?: string[]
  host_permissions?: string[]
  declarative_net_request?: { rule_resources?: { id: string; enabled?: boolean; path: string }[] }
}

function readText(files: FilesInterface, directory: string, path: string): string | null {
  let raw: string | null
  try {
    raw = files.read(directory, path)
  } catch {
    return null
  }
  if (raw === null) return null
  const parsed = JSON.parse(raw) as { text?: string } | null
  return typeof parsed?.text === "string" ? parsed.text : null
}

function readBase64(files: FilesInterface, directory: string, path: string): string | null {
  try {
    const raw = files.read(directory, path)
    const parsed = raw === null ? null : JSON.parse(raw) as { base64?: string }
    return typeof parsed?.base64 === "string" ? parsed.base64 : null
  } catch {
    return null
  }
}

const GM_NAMES = ["GM_addStyle", "GM_getValue", "GM_setValue", "GM_deleteValue", "GM_listValues", "GM_xmlhttpRequest", "GM_info", "unsafeWindow", "GM"]

/**
 * A userscript entry as the shell sends it: `@once/platform-mobile`'s
 * `nativeExtensionSettings` passes each script parsed (`body` and the
 * matching keys, as iOS takes them); the synced document's own form carries
 * the whole `source`.
 */
export interface Tier2UserscriptEntry {
  id: string
  name?: string
  enabled: boolean
  source?: string
  body?: string
  matches?: string[]
  includes?: string[]
  excludes?: string[]
  runAt?: string
  noFrames?: boolean
}

const RUN_AT = new Set(["document-start", "document-end", "document-idle"])

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : []
}

/** The script's identity, matching keys and body, from either form; null when it has neither. */
function readEntry(entry: Tier2UserscriptEntry): { script: Tier2ScriptInfo; body: string } | null {
  if (typeof entry.source === "string") {
    let parsed
    try {
      parsed = parseUserscript(entry.source)
    } catch {
      return null
    }
    const { metadata } = parsed
    return {
      body: parsed.body,
      script: {
        id: entry.id, name: metadata.name, version: metadata.version, namespace: metadata.namespace,
        matches: [...metadata.matches], includes: [...metadata.includes], excludes: [...metadata.excludes],
        runAt: metadata.runAt, noFrames: metadata.noFrames, grants: [...metadata.grants]
      }
    }
  }
  if (typeof entry.body !== "string") return null
  return {
    body: entry.body,
    script: {
      id: entry.id, name: typeof entry.name === "string" ? entry.name : entry.id, version: null, namespace: null,
      matches: strings(entry.matches), includes: strings(entry.includes), excludes: strings(entry.excludes),
      runAt: (RUN_AT.has(String(entry.runAt)) ? entry.runAt : "document-end") as Tier2ScriptInfo["runAt"],
      noFrames: entry.noFrames === true, grants: []
    }
  }
}

/** One synced userscript as a page source for the runtime under `key`, or null when it is off or unreadable. */
export function userscriptSource(key: string, entry: Tier2UserscriptEntry): string | null {
  if (entry.enabled === false || typeof entry.id !== "string") return null
  const read = readEntry(entry)
  if (!read) return null
  const { script, body } = read
  // The body is spliced in as code (the page's policy may refuse eval); a
  // syntax error then fails this source alone, since Java registers each
  // separately. The line break keeps a trailing line comment closed.
  const run = `function (__onceGm) {\nconst { ${GM_NAMES.join(", ")} } = __onceGm;\n${body}\n}`
  const runtime = `window[${JSON.stringify(key)}]`
  return `(function () {\nif (!${runtime}) return;\n${runtime}.userscript(${JSON.stringify(script)}, ${run});\n})();`
}

/**
 * The userscripts as page sources: the runtime bundle under a fresh key,
 * one source per script, and the key's removal. Empty without scripts.
 */
export function userscriptSources(bundle: string, entries: readonly Tier2UserscriptEntry[], key = `__onceTier2${crypto.randomUUID().replace(/-/g, "")}`): string[] {
  const scripts = entries.map((entry) => userscriptSource(key, entry)).filter((source): source is string => source !== null)
  if (scripts.length === 0) return []
  const runtime = `(function () {\nconst ONCE_TIER2 = ${JSON.stringify({ kind: "runtime", key })};\n${bundle}\n})();`
  return [runtime, ...scripts, `(function () { delete window[${JSON.stringify(key)}]; })();`]
}

/** The lists' cosmetics as a page source inserting one `<style>` at document start; null without selectors. */
export function cosmeticSource(selectors: readonly string[]): string | null {
  if (selectors.length === 0) return null
  return `(function () {\nconst style = document.createElement("style");\nstyle.textContent = ${JSON.stringify(cosmeticCss(selectors))};\n(document.head || document.documentElement).append(style);\n})();`
}

/**
 * uBO Lite's generic cosmetic filtering for its enabled rulesets: its
 * `isolated-api.js`, the rulesets' selector maps and `css-generic.js`, with
 * the extension's `self` replaced by a closure object (so nothing lands on
 * the page's window) whose `cssAPI` inserts the sheets as `<style>`.
 */
export function uboliteCosmeticSource(files: FilesInterface, directory: string, rulesetIds: readonly string[]): string | null {
  const generic = rulesetIds
    .map((id) => readText(files, directory, `rulesets/scripting/generic/${id}.js`))
    .filter((text): text is string => text !== null)
  const api = readText(files, directory, "js/scripting/isolated-api.js")
  const engine = readText(files, directory, "js/scripting/css-generic.js")
  if (generic.length === 0 || api === null || engine === null) return null
  const shim = [
    "const self = {",
    "  requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),",
    "  cancelAnimationFrame: (id) => window.cancelAnimationFrame(id),",
    "  setTimeout: (callback, delay) => window.setTimeout(callback, delay),",
    "  clearTimeout: (id) => window.clearTimeout(id),",
    "  addEventListener: (...args) => window.addEventListener(...args),",
    "  cssAPI: { insert(css) { const style = document.createElement('style'); style.textContent = css; (document.head || document.documentElement).append(style); } }",
    "};"
  ].join("\n")
  return `(function () {\n${shim}\n${api}\n${generic.join("\n")}\n${engine}\n})();`
}

interface UboliteBundle {
  directory: string
  manifest: Manifest
  /** Enabled ruleset ids, manifest order. */
  rulesets: string[]
  paths: Map<string, string>
}

export interface LiteTier2Options {
  channel: JavaChannel
  files: FilesInterface
  /** `lite-tier2-page.js`. */
  bundle(): string
  locale(): string
  bundled: readonly BundledExtensionParam[]
  ubolite?: BundledExtensionParam
  /** Extensions the user installed, for the catalogue. */
  installed(): Promise<CatalogEntry[]>
}

export class LiteTier2 {
  private readonly ubolite: UboliteBundle | null
  private listRules: DnrRule[] = []
  private listSelectors: string[] = []
  private userscripts: Tier2UserscriptEntry[] = []
  private session: DnrRule[] = []
  private pushing: Promise<unknown> = Promise.resolve()
  private bundledEntries: Promise<CatalogEntry[]> | null = null
  /** What Java compiled at the last push (diagnostics, tests). */
  lastCounts: Record<string, number> = {}

  constructor(private readonly options: LiteTier2Options) {
    this.ubolite = this.readUbolite()
  }

  private readUbolite(): UboliteBundle | null {
    const param = this.options.ubolite
    if (!param?.present) return null
    const text = readText(this.options.files, param.directory, "manifest.json")
    if (text === null) return null
    const manifest = JSON.parse(text) as Manifest
    const resources = manifest.declarative_net_request?.rule_resources ?? []
    const paths = new Map(resources.map((resource) => [resource.id, resource.path.replace(/^\/+/, "")]))
    return { directory: param.directory, manifest, rulesets: resources.filter((resource) => resource.enabled).map((resource) => resource.id), paths }
  }

  /** Installs uBO Lite's rules and cosmetics before the first settings arrive. */
  async start(): Promise<void> {
    await this.push()
  }

  private message(key: string | undefined): string {
    const ubolite = this.ubolite
    if (!ubolite || !key) return ""
    const match = /^__MSG_(\w+)__$/.exec(key)
    if (!match) return key
    for (const locale of [this.options.locale().replace("-", "_"), this.options.locale().split("-")[0], ubolite.manifest.default_locale ?? "en"]) {
      const text = readText(this.options.files, ubolite.directory, `_locales/${locale}/messages.json`)
      if (text === null) continue
      const messages = JSON.parse(text) as Record<string, { message?: string }>
      const found = messages[match[1]] ?? Object.entries(messages).find(([name]) => name.toLowerCase() === match[1].toLowerCase())?.[1]
      if (found?.message) return found.message
    }
    return ""
  }

  private uboliteEntry(): CatalogEntry | null {
    const ubolite = this.ubolite
    if (!ubolite) return null
    const entry: CatalogEntry = {
      id: UBOLITE_ID,
      name: this.message(ubolite.manifest.name) || "uBlock Origin Lite",
      description: this.message(ubolite.manifest.description),
      version: ubolite.manifest.version ?? "",
      enabled: true,
      bundled: true,
      hasOptions: false,
      hasAction: false,
      permissions: [...ubolite.manifest.permissions ?? [], ...ubolite.manifest.host_permissions ?? []],
      disabledReason: ""
    }
    const icons = ubolite.manifest.icons ?? {}
    const size = Object.keys(icons).map(Number).filter((value) => value <= 128).sort((a, b) => b - a)[0]
    const icon = size === undefined ? null : readBase64(this.options.files, ubolite.directory, icons[String(size)].replace(/^\/+/, ""))
    if (icon) entry.iconDataUrl = `data:image/png;base64,${icon}`
    return entry
  }

  private limited(entry: CatalogEntry): CatalogEntry {
    return { ...entry, enabled: false, hasOptions: false, hasAction: false, disabledReason: TIER2_DISABLED_REASON }
  }

  /** The bundled full extensions, read once: listed, not loaded. */
  private bundledCatalog(): Promise<CatalogEntry[]> {
    this.bundledEntries ??= Promise.all(this.options.bundled.filter((bundle) => bundle.present).map(async (bundle) => {
      try {
        const extension = await loadExtension(bundle.directory, new LiteFileReader(this.options.files, bundle.directory), this.options.locale())
        const entry: CatalogEntry = {
          id: extension.id, name: extension.name, description: extension.description, version: extension.manifest.version,
          enabled: false, bundled: true, hasOptions: false, hasAction: false,
          permissions: [...extension.manifest.permissions, ...extension.manifest.hostPermissions], disabledReason: TIER2_DISABLED_REASON
        }
        const icon = await extensionIconDataUrl(extension)
        if (icon) entry.iconDataUrl = icon
        return entry
      } catch (error) {
        return { id: bundle.id, name: bundle.id, description: "", version: "", enabled: false, bundled: true,
          hasOptions: false, hasAction: false, permissions: [], disabledReason: `${TIER2_DISABLED_REASON} (${String(error)})` }
      }
    }))
    return this.bundledEntries
  }

  /** uBO Lite first (the one that runs), then the bundled and installed extensions, limited. */
  async catalog(): Promise<CatalogEntry[]> {
    const ubolite = this.uboliteEntry()
    const bundled = await this.bundledCatalog()
    const ids = new Set(bundled.map((entry) => entry.id))
    const installed = (await this.options.installed().catch(() => [])).filter((entry) => !ids.has(entry.id)).map((entry) => this.limited(entry))
    return [...ubolite ? [ubolite] : [], ...bundled, ...installed]
  }

  /** The shell's `extensionCommand` in Tier 2: listing only. */
  async command(action: string, id?: string): Promise<{ extensions?: CatalogEntry[]; noPage?: boolean }> {
    if (action === "list") return { extensions: await this.catalog() }
    if ((action === "options" || action === "action") && id === UBOLITE_ID) return { noPage: true }
    throw new RequestError(TIER2_DISABLED_REASON, "LIMITED")
  }

  /** Fetches and converts the synced lists, takes the userscripts, and puts both in force. */
  async applySettings(settings: ExtensionSettings): Promise<void> {
    const parsed: ParsedFilterList[] = []
    await Promise.all(settings.filterLists.lists.filter((entry) => entry.enabled !== false).map(async (entry) => {
      try {
        const result = await this.options.channel.request<Tier2FetchListResult>("tier2.fetchList", { url: entry.url })
        if (result.status < 200 || result.status >= 300 || typeof result.text !== "string") throw new Error(`status ${result.status}`)
        parsed.push(parseFilterList(result.text))
      } catch (error) {
        this.options.channel.log("warn", `Filter list ${entry.url} was not applied: ${String(error)}`)
      }
    }))
    const converted = filterListRules(parsed)
    this.listRules = converted.rules
    this.listSelectors = converted.selectors
    this.userscripts = (settings.userscripts.scripts as unknown[]).filter((entry): entry is Tier2UserscriptEntry =>
      typeof entry === "object" && entry !== null && typeof (entry as Tier2UserscriptEntry).id === "string")
    this.options.channel.log("log", `Tier 2 filter lists: ${converted.rules.length} network rules, ${converted.selectors.length} cosmetic selectors; ${converted.skipped} unsupported rules skipped`)
    await this.push()
  }

  /** `declarativeNetRequest.updateSessionRules` for uBO Lite's group (tests, diagnostics). */
  async updateSessionRules(params: SessionRulesParams): Promise<NetRulesResult> {
    const removed = new Set(Array.isArray(params.removeRuleIds) ? params.removeRuleIds.filter(Number.isInteger) as number[] : [])
    if (params.addRules !== undefined && !Array.isArray(params.addRules)) throw new Error("addRules must be a list of rules")
    const added = ((params.addRules as unknown[] | undefined) ?? []).map((rule, index) => parseDnrRule(rule, `addRules[${index}]`))
    const next = this.session.filter((rule) => !removed.has(rule.id))
    const ids = new Set(next.map((rule) => rule.id))
    for (const rule of added) {
      if (ids.has(rule.id)) throw new Error(`rule id ${rule.id} is already in use`)
      ids.add(rule.id)
      next.push(rule)
    }
    if (next.length > MAX_SESSION_RULES) throw new Error("too many session rules")
    this.session = next
    return this.push()
  }

  /** The rule groups as Java takes them. */
  ruleGroups(): NetRuleGroup[] {
    const groups: NetRuleGroup[] = []
    const ubolite = this.ubolite
    if (ubolite) {
      const rulesets: string[] = []
      for (const id of ubolite.rulesets) {
        const path = ubolite.paths.get(id)
        if (path) rulesets.push(path)
        // Its regex rules ship beside the main ones; Java skips a missing file.
        rulesets.push(`rulesets/regex/${id}.json`)
      }
      groups.push({ id: UBOLITE_GROUP, directory: ubolite.directory, rulesets, rules: this.session })
    }
    groups.push({ id: LISTS_GROUP, rules: this.listRules })
    return groups
  }

  /** The page sources as Java registers them, in order. */
  pageSources(): string[] {
    const sources: string[] = []
    const cosmetics = cosmeticSource(this.listSelectors)
    if (cosmetics) sources.push(cosmetics)
    if (this.ubolite) {
      const ubolite = uboliteCosmeticSource(this.options.files, this.ubolite.directory, this.ubolite.rulesets)
      if (ubolite) sources.push(ubolite)
    }
    if (this.userscripts.some((entry) => entry.enabled !== false)) sources.push(...userscriptSources(this.options.bundle(), this.userscripts))
    return sources
  }

  /** Rules, then scripts; one push at a time, so the newest state lands last. */
  private push(): Promise<NetRulesResult> {
    const next = this.pushing.catch(() => undefined).then(async () => {
      const result = await this.options.channel.request<NetRulesResult>("net.rules", { groups: this.ruleGroups() } satisfies NetRulesParams)
      this.lastCounts = result?.counts ?? {}
      await this.options.channel.request("tier2.scripts", { sources: this.pageSources() } satisfies Tier2ScriptsParams)
      return result
    })
    this.pushing = next
    return next
  }
}
