// One extension's `declarativeNetRequest` rules: the static rulesets its
// package ships, the dynamic rules it adds (kept on disk beside its
// storage), and the session rules that live as long as the host does. The
// matcher over all of them is built once and rebuilt when any set changes.

import { promises as fs } from "node:fs"
import path from "node:path"
import {
  DnrMatcher,
  DnrRule,
  DnrRuleError,
  hasDeclarativeNetRequest,
  parseDnrRule,
  parseDnrRules
} from "@once/core"
import { LoadedExtension, resolveExtensionFile } from "./LoadedExtension"
import { extensionUrl } from "./ExtensionScheme"
import { DNR_LIMITS } from "./protocol"

export interface UpdateRulesOptions {
  removeRuleIds?: unknown
  addRules?: unknown
}

export interface UpdateRulesetsOptions {
  enableRulesetIds?: unknown
  disableRulesetIds?: unknown
}

interface StaticRuleset {
  readonly id: string
  readonly rules: readonly DnrRule[]
}

interface Persisted {
  /** Null until `updateEnabledRulesets` first departs from the manifest. */
  enabledRulesets: string[] | null
  dynamicRules: unknown[]
}

function stringList(value: unknown, what: string): string[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((entry) => typeof entry === "string")) {
    throw new Error(`${what} must be a list of strings`)
  }
  return value
}

function idList(value: unknown, what: string): number[] {
  if (value === undefined) return []
  if (!Array.isArray(value) || !value.every((entry) => Number.isInteger(entry))) {
    throw new Error(`${what} must be a list of rule ids`)
  }
  return value
}

/**
 * `removeRuleIds` then `addRules`, checked as a whole before anything
 * changes: the ids left must be unique and the totals within the limits.
 */
function updated(
  current: readonly DnrRule[],
  options: UpdateRulesOptions,
  other: readonly DnrRule[],
  what: string
): DnrRule[] {
  const removed = new Set(idList(options.removeRuleIds, `${what}.removeRuleIds`))
  if (options.addRules !== undefined && !Array.isArray(options.addRules)) {
    throw new Error(`${what}.addRules must be a list of rules`)
  }
  const added = ((options.addRules as unknown[] | undefined) ?? []).map((rule, index) =>
    parseDnrRule(rule, `${what}.addRules[${index}]`)
  )
  const next = current.filter((rule) => !removed.has(rule.id))
  const ids = new Set(next.map((rule) => rule.id))
  for (const rule of added) {
    if (ids.has(rule.id)) throw new Error(`${what}: rule id ${rule.id} is already in use`)
    ids.add(rule.id)
    next.push(rule)
  }
  if (next.length + other.length > DNR_LIMITS.MAX_NUMBER_OF_DYNAMIC_AND_SESSION_RULES) {
    throw new Error(`${what}: too many dynamic and session rules`)
  }
  const regexRules = [...next, ...other].filter((rule) => rule.condition.regexFilter !== undefined).length
  if (regexRules > DNR_LIMITS.MAX_NUMBER_OF_REGEX_RULES) throw new Error(`${what}: too many regex rules`)
  return next
}

function filtered(rules: readonly DnrRule[], filter: unknown): DnrRule[] {
  const ids = typeof filter === "object" && filter !== null ? (filter as { ruleIds?: unknown }).ruleIds : undefined
  if (ids === undefined) return [...rules]
  const wanted = new Set(idList(ids, "filter.ruleIds"))
  return rules.filter((rule) => wanted.has(rule.id))
}

export class DnrRulesets {
  readonly extensionId: string
  /** Whether the manifest asks for the API; without it nothing is enforced. */
  readonly available: boolean
  private readonly statics = new Map<string, StaticRuleset>()
  private enabled = new Set<string>()
  private dynamic: DnrRule[] = []
  private session: DnrRule[] = []
  private compiled: DnrMatcher | null = null
  private writing: Promise<void> = Promise.resolve()
  private readonly baseUrl: string

  constructor(private readonly extension: LoadedExtension, private readonly file: string) {
    this.extensionId = extension.id
    this.available = hasDeclarativeNetRequest(extension.manifest)
    this.baseUrl = extensionUrl(extension.host, "/")
  }

  /**
   * Reads the static rule files and the persisted dynamic state. A ruleset
   * that fails to parse is skipped with a log line, as Firefox skips it, so
   * one bad file does not take the extension down.
   */
  async load(): Promise<void> {
    if (!this.available) return
    const manifestEnabled = new Set<string>()
    for (const spec of this.extension.manifest.ruleResources.slice(0, DNR_LIMITS.MAX_NUMBER_OF_STATIC_RULESETS)) {
      if (spec.enabled) manifestEnabled.add(spec.id)
      const file = resolveExtensionFile(this.extension, spec.path)
      if (!file) {
        console.error(`[${this.extension.name}] ruleset ${spec.id}: ${spec.path} is outside the extension`)
        continue
      }
      try {
        const rules = parseDnrRules(JSON.parse(await fs.readFile(file, "utf8")), `ruleset ${spec.id}`)
        this.statics.set(spec.id, { id: spec.id, rules })
      } catch (error) {
        const reason = error instanceof DnrRuleError ? error.message : String(error)
        console.error(`[${this.extension.name}] ruleset ${spec.id} was not loaded: ${reason}`)
      }
    }
    const persisted = await this.readPersisted()
    this.enabled = new Set(
      (persisted.enabledRulesets ?? [...manifestEnabled]).filter((id) => this.statics.has(id))
    )
    this.dynamic = []
    persisted.dynamicRules.forEach((rule, index) => {
      try {
        this.dynamic.push(parseDnrRule(rule, `dynamic rule [${index}]`))
      } catch (error) {
        console.error(`[${this.extension.name}] a stored dynamic rule was dropped: ${String(error)}`)
      }
    })
    this.compiled = null
  }

  private async readPersisted(): Promise<Persisted> {
    try {
      const parsed: unknown = JSON.parse(await fs.readFile(this.file, "utf8"))
      if (typeof parsed === "object" && parsed !== null) {
        const record = parsed as Partial<Persisted>
        return {
          enabledRulesets: Array.isArray(record.enabledRulesets) ? record.enabledRulesets.map(String) : null,
          dynamicRules: Array.isArray(record.dynamicRules) ? record.dynamicRules : []
        }
      }
    } catch {
      // No file yet, or an unreadable one: the manifest decides.
    }
    return { enabledRulesets: null, dynamicRules: [] }
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify({ enabledRulesets: [...this.enabled], dynamicRules: this.dynamic })
    this.writing = this.writing.then(async () => {
      await fs.mkdir(path.dirname(this.file), { recursive: true })
      await fs.writeFile(`${this.file}.tmp`, snapshot, "utf8")
      await fs.rename(`${this.file}.tmp`, this.file)
    })
    return this.writing
  }

  /** Waits for the last write; safe at unload. */
  flush(): Promise<void> {
    return this.writing.catch(() => undefined)
  }

  /** Session rules first, then dynamic, then the enabled static sets. */
  matcher(): DnrMatcher | null {
    if (!this.available) return null
    if (!this.compiled) {
      const rules: DnrRule[] = [...this.session, ...this.dynamic]
      for (const spec of this.extension.manifest.ruleResources) {
        if (this.enabled.has(spec.id)) rules.push(...(this.statics.get(spec.id)?.rules ?? []))
      }
      this.compiled = new DnrMatcher(rules, { extensionBaseUrl: this.baseUrl })
    }
    return this.compiled
  }

  getEnabledRulesets(): string[] {
    return this.extension.manifest.ruleResources
      .map((spec) => spec.id)
      .filter((id) => this.enabled.has(id))
  }

  async updateEnabledRulesets(options: UpdateRulesetsOptions): Promise<void> {
    const disable = stringList(options.disableRulesetIds, "disableRulesetIds")
    const enable = stringList(options.enableRulesetIds, "enableRulesetIds")
    for (const id of [...disable, ...enable]) {
      if (!this.statics.has(id)) throw new Error(`Invalid ruleset id: ${id}`)
    }
    const next = new Set(this.enabled)
    for (const id of disable) next.delete(id)
    for (const id of enable) next.add(id)
    if (next.size > DNR_LIMITS.MAX_NUMBER_OF_ENABLED_STATIC_RULESETS) {
      throw new Error("Too many enabled static rulesets")
    }
    this.enabled = next
    this.compiled = null
    await this.persist()
  }

  /** How many static rules may still be enabled under the guaranteed minimum. */
  getAvailableStaticRuleCount(): number {
    let enabledRules = 0
    for (const id of this.enabled) enabledRules += this.statics.get(id)?.rules.length ?? 0
    return Math.max(0, DNR_LIMITS.GUARANTEED_MINIMUM_STATIC_RULES - enabledRules)
  }

  getDynamicRules(filter?: unknown): DnrRule[] {
    return filtered(this.dynamic, filter)
  }

  async updateDynamicRules(options: UpdateRulesOptions): Promise<void> {
    this.dynamic = updated(this.dynamic, options, this.session, "updateDynamicRules")
    this.compiled = null
    await this.persist()
  }

  getSessionRules(filter?: unknown): DnrRule[] {
    return filtered(this.session, filter)
  }

  updateSessionRules(options: UpdateRulesOptions): void {
    this.session = updated(this.session, options, this.dynamic, "updateSessionRules")
    this.compiled = null
  }
}
