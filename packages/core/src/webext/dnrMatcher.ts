// The pure half of `declarativeNetRequest`: compiling a rule's condition,
// deciding which rules a request matches, and resolving what the winning
// rule asks for. Nothing here touches a network stack, so the bridge that
// feeds it real requests stays thin and the semantics are unit-tested here.
//
// Priority resolution follows the specification: the highest priority wins;
// at equal priority allow and allowAllRequests beat block, block beats
// upgradeScheme, upgradeScheme beats redirect. modifyHeaders rules never
// compete for the request itself; every matching one applies unless a
// higher-priority allow ended the evaluation or a block/redirect took it.

import { DnrHeaderInfo, DnrResourceType, DnrRule, DnrUrlTransform } from "./dnrRules"

export interface DnrRequest {
  readonly url: string
  readonly type: DnrResourceType
  /** Any case; compared lower-case. */
  readonly method: string
  /** The URL of the page making the request; absent for a top navigation. */
  readonly initiator?: string | null
  readonly tabId?: number
  /**
   * The priority of an `allowAllRequests` rule that matched the frame this
   * request comes from, when one did. It acts as an allow rule of that
   * priority for the request.
   */
  readonly frameAllowPriority?: number
}

export type DnrOutcome = "none" | "allow" | "block" | "upgradeScheme" | "redirect"

export interface DnrDecision {
  readonly outcome: DnrOutcome
  /** The rule that decided, or null when nothing did or the frame's allow did. */
  readonly rule: DnrRule | null
  readonly redirectUrl?: string
  /** The modifyHeaders rules to apply, highest priority first. */
  readonly modifyHeaders: readonly DnrRule[]
}

export interface DnrHeader {
  name: string
  value: string
}

/** Which action wins a tie at the same priority: larger beats smaller. */
const RANK: Readonly<Record<string, number>> = {
  allow: 4, allowAllRequests: 4, block: 3, upgradeScheme: 2, redirect: 1
}

// Chrome's separator: anything that is not a letter, a digit or one of
// `_ - . %`, or the end of the URL.
const SEPARATOR = "(?:[^a-zA-Z0-9_\\-.%]|$)"

/**
 * A `urlFilter` as a regular expression: `||` anchors at a domain boundary
 * after the scheme, `|` anchors at either end, `*` matches anything and `^`
 * is a separator. Anything else is literal, and matching is a substring
 * search unless anchored.
 */
export function compileUrlFilter(filter: string, caseSensitive: boolean): RegExp {
  let source = ""
  let rest = filter
  if (rest.startsWith("||")) {
    source += "^[a-zA-Z][a-zA-Z0-9+.-]*://(?:[^/?#]*\\.)?"
    rest = rest.slice(2)
  } else if (rest.startsWith("|")) {
    source += "^"
    rest = rest.slice(1)
  }
  let anchoredEnd = false
  if (rest.endsWith("|")) {
    anchoredEnd = true
    rest = rest.slice(0, -1)
  }
  for (const character of rest) {
    if (character === "*") source += ".*"
    else if (character === "^") source += SEPARATOR
    else source += character.replace(/[.+?^${}()|[\]\\/]/g, "\\$&")
  }
  if (anchoredEnd) source += "$"
  return new RegExp(source, caseSensitive ? "" : "i")
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/\.$/, "")
  } catch {
    return null
  }
}

/** Whether `host` is one of the domains or a subdomain of one. */
function inDomains(host: string, domains: readonly string[]): boolean {
  return domains.some((domain) => host === domain || host.endsWith(`.${domain}`))
}

// The last two labels stand in for the registrable domain: no public suffix
// list here, the same approximation the webRequest details use.
function registrableDomain(host: string): string {
  const labels = host.split(".")
  return labels.length <= 2 ? host : labels.slice(-2).join(".")
}

/** A request with no initiator, or one from the same site, is first party. */
export function isThirdPartyRequest(url: string, initiator: string | null | undefined): boolean {
  if (!initiator) return false
  const requestHost = hostOf(url)
  const initiatorHost = hostOf(initiator)
  if (requestHost === null || initiatorHost === null) return false
  return registrableDomain(requestHost) !== registrableDomain(initiatorHost)
}

interface CompiledRule {
  readonly rule: DnrRule
  readonly pattern: RegExp | null
  readonly regex: RegExp | null
}

function compile(rule: DnrRule): CompiledRule {
  const { condition } = rule
  const caseSensitive = condition.isUrlFilterCaseSensitive === true
  return {
    rule,
    pattern: condition.urlFilter !== undefined ? compileUrlFilter(condition.urlFilter, caseSensitive) : null,
    regex: condition.regexFilter !== undefined ? new RegExp(condition.regexFilter, caseSensitive ? "" : "i") : null
  }
}

function conditionMatches(compiled: CompiledRule, request: DnrRequest, requestHost: string | null): boolean {
  const { condition } = compiled.rule
  if (condition.resourceTypes && !condition.resourceTypes.includes(request.type)) return false
  if (condition.excludedResourceTypes?.includes(request.type)) return false
  const method = request.method.toLowerCase()
  if (condition.requestMethods && !condition.requestMethods.includes(method)) return false
  if (condition.excludedRequestMethods?.includes(method)) return false
  if (request.tabId !== undefined) {
    if (condition.tabIds && !condition.tabIds.includes(request.tabId)) return false
    if (condition.excludedTabIds?.includes(request.tabId)) return false
  }
  if (condition.domainType) {
    const thirdParty = isThirdPartyRequest(request.url, request.initiator)
    if ((condition.domainType === "thirdParty") !== thirdParty) return false
  }
  if (condition.requestDomains || condition.excludedRequestDomains) {
    if (requestHost === null) return false
    if (condition.requestDomains && !inDomains(requestHost, condition.requestDomains)) return false
    if (condition.excludedRequestDomains && inDomains(requestHost, condition.excludedRequestDomains)) return false
  }
  if (condition.initiatorDomains || condition.excludedInitiatorDomains) {
    const initiatorHost = request.initiator ? hostOf(request.initiator) : null
    // A request without an initiator matches no domain list, but is not
    // excluded by one either, as in Chrome.
    if (condition.initiatorDomains && (initiatorHost === null || !inDomains(initiatorHost, condition.initiatorDomains))) {
      return false
    }
    if (condition.excludedInitiatorDomains && initiatorHost !== null &&
      inDomains(initiatorHost, condition.excludedInitiatorDomains)) {
      return false
    }
  }
  if (compiled.pattern && !compiled.pattern.test(request.url)) return false
  if (compiled.regex && !compiled.regex.test(request.url)) return false
  return true
}

/** `transform` applied to a URL; null when the result is not a URL. */
export function transformUrl(url: string, transform: DnrUrlTransform): string | null {
  try {
    const target = new URL(url)
    if (transform.scheme !== undefined) target.protocol = `${transform.scheme}:`
    if (transform.host !== undefined) target.hostname = transform.host
    if (transform.port !== undefined) target.port = transform.port
    if (transform.path !== undefined) target.pathname = transform.path
    if (transform.query !== undefined) target.search = transform.query
    if (transform.queryTransform) {
      for (const key of transform.queryTransform.removeParams ?? []) target.searchParams.delete(key)
      for (const param of transform.queryTransform.addOrReplaceParams ?? []) {
        if (target.searchParams.has(param.key)) target.searchParams.set(param.key, param.value)
        else if (!param.replaceOnly) target.searchParams.append(param.key, param.value)
      }
    }
    if (transform.fragment !== undefined) target.hash = transform.fragment
    if (transform.username !== undefined) target.username = transform.username
    if (transform.password !== undefined) target.password = transform.password
    return target.href
  } catch {
    return null
  }
}

// `\1`..`\9` name capture groups and `\0` the whole match; a literal `$` in
// the substitution must survive String.replace's own syntax.
function substitution(template: string): string {
  return template
    .replace(/\$/g, "$$$$")
    .replace(/\\(\d)/g, (_match, digit: string) => (digit === "0" ? "$&" : `$${digit}`))
}

/**
 * Where a redirect rule sends this URL, with `extensionPath` resolved
 * against the extension's origin. Null when the rule produces no valid
 * URL, or the same one, which would loop.
 */
function resolveRedirect(compiled: CompiledRule, url: string, extensionBaseUrl: string): string | null {
  const redirect = compiled.rule.action.redirect
  if (!redirect) return null
  let target: string | null = null
  if (redirect.url !== undefined) target = redirect.url
  else if (redirect.extensionPath !== undefined) {
    target = `${extensionBaseUrl.replace(/\/+$/, "")}${redirect.extensionPath}`
  } else if (redirect.regexSubstitution !== undefined && compiled.regex) {
    target = url.replace(compiled.regex, substitution(redirect.regexSubstitution))
  } else if (redirect.transform) {
    target = transformUrl(url, redirect.transform)
  }
  if (target === null) return null
  try {
    target = new URL(target).href
  } catch {
    return null
  }
  return target === url ? null : target
}

function upgraded(url: string): string | null {
  if (url.startsWith("http://")) return `https://${url.slice("http://".length)}`
  if (url.startsWith("ws://")) return `wss://${url.slice("ws://".length)}`
  return null
}

export interface DnrMatcherOptions {
  /** `moz-extension://<host>/`, for `redirect.extensionPath`. */
  readonly extensionBaseUrl: string
}

/**
 * One extension's rules, in precedence order for ties (session before
 * dynamic before static, as the browsers order them), compiled once.
 */
export class DnrMatcher {
  private readonly rules: readonly CompiledRule[]

  constructor(rules: readonly DnrRule[], private readonly options: DnrMatcherOptions) {
    this.rules = rules.map(compile)
  }

  get size(): number {
    return this.rules.length
  }

  evaluate(request: DnrRequest): DnrDecision {
    const requestHost = hostOf(request.url)
    let best: CompiledRule | null = null
    const modifiers: DnrRule[] = []
    for (const compiled of this.rules) {
      if (!conditionMatches(compiled, request, requestHost)) continue
      const { rule } = compiled
      if (rule.action.type === "modifyHeaders") {
        modifiers.push(rule)
        continue
      }
      if (best === null || rule.priority > best.rule.priority ||
        (rule.priority === best.rule.priority && RANK[rule.action.type] > RANK[best.rule.action.type])) {
        best = compiled
      }
    }
    const frameAllow = request.frameAllowPriority
    if (frameAllow !== undefined && (best === null || best.rule.priority <= frameAllow)) {
      return { outcome: "allow", rule: null, modifyHeaders: this.headerRules(modifiers, frameAllow) }
    }
    if (best === null) return { outcome: "none", rule: null, modifyHeaders: this.headerRules(modifiers, 0) }
    const { rule } = best
    switch (rule.action.type) {
      case "allow":
      case "allowAllRequests":
        return { outcome: "allow", rule, modifyHeaders: this.headerRules(modifiers, rule.priority) }
      case "block":
        return { outcome: "block", rule, modifyHeaders: [] }
      case "upgradeScheme": {
        const target = upgraded(request.url)
        return target === null
          ? { outcome: "upgradeScheme", rule, modifyHeaders: [] }
          : { outcome: "upgradeScheme", rule, redirectUrl: target, modifyHeaders: [] }
      }
      default: {
        const target = resolveRedirect(best, request.url, this.options.extensionBaseUrl)
        return target === null
          ? { outcome: "none", rule: null, modifyHeaders: this.headerRules(modifiers, 0) }
          : { outcome: "redirect", rule, redirectUrl: target, modifyHeaders: [] }
      }
    }
  }

  /** modifyHeaders rules an allow of `floor` priority does not override. */
  private headerRules(modifiers: DnrRule[], floor: number): DnrRule[] {
    return modifiers
      .filter((rule) => rule.priority >= floor)
      .sort((a, b) => b.priority - a.priority)
  }
}

/**
 * The header list after the modifyHeaders rules run, highest priority
 * first, or null when nothing changed. A header set or removed by one rule
 * is settled: later rules leave it alone. An appended header still takes
 * further appends, but no set or remove. Request headers append by joining
 * the value onto the existing one, response headers by adding an entry.
 */
export function applyHeaderModifications(
  headers: readonly DnrHeader[],
  rules: readonly DnrRule[],
  kind: "requestHeaders" | "responseHeaders"
): DnrHeader[] | null {
  let list = headers.map((header) => ({ ...header }))
  let changed = false
  const settled = new Set<string>()
  const appended = new Set<string>()
  const apply = (info: DnrHeaderInfo) => {
    const name = info.header.toLowerCase()
    if (settled.has(name)) return
    if (info.operation === "append") {
      appended.add(name)
      const existing = kind === "requestHeaders" ? list.find((header) => header.name.toLowerCase() === name) : undefined
      if (existing) existing.value = `${existing.value}, ${info.value ?? ""}`
      else list.push({ name: info.header, value: info.value ?? "" })
      changed = true
      return
    }
    if (appended.has(name)) return
    settled.add(name)
    const before = list.length
    list = list.filter((header) => header.name.toLowerCase() !== name)
    if (info.operation === "set") list.push({ name: info.header, value: info.value ?? "" })
    changed ||= info.operation === "set" || list.length !== before
  }
  for (const rule of rules) {
    for (const info of rule.action[kind] ?? []) apply(info)
  }
  return changed ? list : null
}
