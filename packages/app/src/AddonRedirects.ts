import {
  AddonRedirect,
  AddonsDocument,
  Redirect,
  addonContributionId,
  isRedirectReplacement,
  moveRedirectedUrl,
  redirectReplacementPrefix
} from "@once/core"
import { CacheStorePort } from "./types"

/** What the add-on's script answers for its dynamic redirects; the UI owns the sandbox. */
export interface AddonRedirectHandler {
  target(redirect: string): Promise<string | null>
  failed(redirect: string, url: string, reason: string): Promise<string | null>
}

/** One add-on redirect as the Redirects settings show it. */
export interface AddonRedirectView {
  key: string
  addonId: string
  addonName: string
  title: string
  match_url: string
  /** The replacement in force; absent while a dynamic rule has none yet. */
  replace_url?: string
  enabled: boolean
  dynamic: boolean
  /** When the script last named the replacement, on this device. */
  updatedAt?: number
}

interface Contributed {
  addonId: string
  addonName: string
  rule: AddonRedirect
  handler: AddonRedirectHandler | null
  replacement?: string
  /** The replacement before the last move, so a straggling failure still finds its new home. */
  previous?: string
  updatedAt?: number
  lastFailover?: number
  refreshing?: Promise<void>
}

// Kept per device beside cached feeds: each device picks its own mirror, and
// startup applies the last pick without waiting for the add-on to start.
const PREFIX = "addon-redirect:"
/** One move per rule in this window, so a dead network cannot walk every mirror. */
const FAILOVER_SPACING_MS = 30_000
const REFRESH_CHECK_MS = 15 * 60_000

/**
 * The redirects add-ons contribute, merged after the user's own rules. The UI
 * registers each add-on's rules with a handler that asks its sandbox; this
 * keeps which are on, what each currently points at, and moves a rule when a
 * page it produced fails to load.
 */
export class AddonRedirects {
  private readonly contributed = new Map<string, Contributed>()
  private toggles = new Map<string, boolean>()
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(
    private readonly cache: CacheStorePort | undefined,
    private readonly changed: () => void,
    private readonly updateAddons: (change: (doc: AddonsDocument) => AddonsDocument) => Promise<void>,
    private readonly now: () => number = () => Date.now()
  ) {}

  /** The enabled rules that have somewhere to point, in manifest order, tagged with their key. */
  rules(): Redirect[] {
    return [...this.contributed.entries()]
      .filter(([key, entry]) => this.enabled(key, entry) && entry.replacement)
      .map(([key, entry]) => ({ match_url: entry.rule.match, replace_url: entry.replacement as string, origin: key }))
  }

  list(): AddonRedirectView[] {
    return [...this.contributed.entries()].map(([key, entry]) => ({
      key, addonId: entry.addonId, addonName: entry.addonName, title: entry.rule.title,
      match_url: entry.rule.match, enabled: this.enabled(key, entry), dynamic: entry.rule.dynamic,
      ...(entry.replacement ? { replace_url: entry.replacement } : {}),
      ...(entry.updatedAt ? { updatedAt: entry.updatedAt } : {})
    }))
  }

  /** The synced on/off choices, read before the rules are; a rule switched on may need a fresh replacement. */
  readToggles(doc: AddonsDocument): void {
    this.toggles = new Map()
    for (const entry of doc.addons) {
      for (const [id, on] of Object.entries(entry.redirectToggles ?? {})) this.toggles.set(addonContributionId(entry.manifest.id, id), on)
    }
    for (const key of this.contributed.keys()) this.refreshIfStale(key)
  }

  /** What the client offers the UI: the panel's list and switches, and the sandbox's side. */
  methods() {
    return {
      getAddonRedirects: () => this.list(),
      setAddonRedirectEnabled: (key: string, enabled: boolean) => this.setEnabled(key, enabled),
      registerAddonRedirects: (addonId: string, addonName: string, rules: readonly AddonRedirect[], handler: AddonRedirectHandler | null) =>
        this.register(addonId, addonName, rules, handler),
      setAddonRedirectTarget: (key: string, replacement: string) => this.setTarget(key, replacement),
      reportRedirectFailure: (url: string, reason: string) => this.reportFailure(url, reason)
    }
  }

  async setEnabled(key: string, enabled: boolean): Promise<void> {
    const entry = this.contributed.get(key)
    if (!entry) throw new Error(`No add-on redirect ${key}`)
    await this.updateAddons((doc) => ({
      ...doc,
      addons: doc.addons.map((candidate) => candidate.manifest.id !== entry.addonId ? candidate : {
        ...candidate, redirectToggles: { ...candidate.redirectToggles, [entry.rule.id]: enabled }
      })
    }))
  }

  /** An add-on's rules while it is registered; the returned function withdraws them. */
  async register(addonId: string, addonName: string, rules: readonly AddonRedirect[], handler: AddonRedirectHandler | null): Promise<() => void> {
    const keys: string[] = []
    for (const rule of rules) {
      const key = addonContributionId(addonId, rule.id)
      const cached = rule.dynamic ? await this.readCached(key) : null
      const entry: Contributed = { addonId, addonName, rule, handler: rule.dynamic ? handler : null,
        replacement: cached?.replacement ?? rule.replace, updatedAt: cached?.at }
      this.contributed.set(key, entry)
      keys.push(key)
    }
    if (keys.length) this.changed()
    for (const key of keys) this.refreshIfStale(key)
    if (handler && rules.some((rule) => rule.dynamic) && !this.timer) {
      // A long session outlives a replacement's age; nothing else would ask again.
      this.timer = setInterval(() => { for (const key of this.contributed.keys()) this.refreshIfStale(key) }, REFRESH_CHECK_MS)
      ;(this.timer as { unref?(): void }).unref?.()
    }
    return () => {
      let removed = false
      for (const key of keys) {
        const entry = this.contributed.get(key)
        if (entry && rules.includes(entry.rule)) removed = this.contributed.delete(key) || removed
      }
      if (removed) this.changed()
    }
  }

  /** The script named a new replacement, on its own or when asked. */
  async setTarget(key: string, replacement: string): Promise<void> {
    const entry = this.contributed.get(key)
    if (!entry || !entry.rule.dynamic) throw new Error(`${key} is not a dynamic redirect`)
    if (!isRedirectReplacement(replacement)) throw new Error("a replacement must be an http(s) URL with a fixed host")
    const at = this.now()
    entry.updatedAt = at
    if (entry.replacement === replacement) {
      await this.cache?.set(PREFIX + key, { replacement, at })
      return
    }
    entry.previous = entry.replacement
    entry.replacement = replacement
    await this.cache?.set(PREFIX + key, { replacement, at })
    this.changed()
  }

  /**
   * A page failed to load. When an enabled rule produced it, its add-on is
   * asked where to go instead; the answer is the same page there, or null
   * when no rule produced it or there is nowhere left to go.
   */
  async reportFailure(url: string, reason: string): Promise<string | null> {
    for (const [key, entry] of this.contributed) {
      if (!this.enabled(key, entry) || !entry.replacement) continue
      if (entry.previous && !url.startsWith(redirectReplacementPrefix(entry.replacement))) {
        // A second tab still on the mirror the rule just left.
        const moved = moveRedirectedUrl(url, entry.previous, entry.replacement)
        if (moved) return moved
      }
      if (!entry.handler || !url.startsWith(redirectReplacementPrefix(entry.replacement))) continue
      const now = this.now()
      if (entry.lastFailover !== undefined && now - entry.lastFailover < FAILOVER_SPACING_MS) return null
      entry.lastFailover = now
      const before = entry.replacement
      const next = await entry.handler.failed(entry.rule.id, url, reason).catch(() => null)
      if (!next || next === before) return null
      await this.setTarget(key, next)
      return moveRedirectedUrl(url, before, next)
    }
    return null
  }

  private enabled(key: string, entry: Contributed): boolean {
    return this.toggles.get(key) ?? entry.rule.enabledByDefault
  }

  /** Asks the add-on again once the replacement it named is older than the rule allows. */
  private refreshIfStale(key: string): void {
    const entry = this.contributed.get(key)
    if (!entry?.handler || entry.refreshing || !this.enabled(key, entry)) return
    const age = entry.updatedAt === undefined ? Infinity : this.now() - entry.updatedAt
    if (age < entry.rule.refreshMinutes * 60_000) return
    const handler = entry.handler
    entry.refreshing = handler.target(entry.rule.id)
      .then((replacement) => replacement && this.contributed.get(key) === entry ? this.setTarget(key, replacement) : undefined)
      .catch((error) => console.warn(`Add-on redirect ${key} could not be refreshed`, error))
      .finally(() => { entry.refreshing = undefined })
  }

  private async readCached(key: string): Promise<{ replacement: string; at: number } | null> {
    const cached = await this.cache?.get(PREFIX + key).catch(() => undefined) as { replacement?: unknown; at?: unknown } | undefined
    return cached && isRedirectReplacement(cached.replacement) && typeof cached.at === "number"
      ? { replacement: cached.replacement, at: cached.at } : null
  }
}
