// The `declarativeNetRequest` rule shape, as Firefox and Chrome define it:
// https://developer.mozilla.org/docs/Mozilla/Add-ons/WebExtensions/API/declarativeNetRequest
//
// Rules arrive as JSON from static rulesets in the package and from
// `updateDynamicRules`/`updateSessionRules` calls. Parsing is strict about
// what the matcher relies on and rejects a rule the same way the browsers
// do, so an extension learns about a bad rule when it adds it rather than
// when a request silently fails to match.

export const DNR_RESOURCE_TYPES = [
  "main_frame", "sub_frame", "stylesheet", "script", "image", "font", "object",
  "xmlhttprequest", "ping", "csp_report", "media", "websocket", "webtransport",
  "webbundle", "other"
] as const

export type DnrResourceType = typeof DNR_RESOURCE_TYPES[number]

export type DnrActionType =
  | "block" | "allow" | "allowAllRequests" | "upgradeScheme" | "redirect" | "modifyHeaders"

export type DnrHeaderOperation = "append" | "set" | "remove"

export interface DnrHeaderInfo {
  readonly header: string
  readonly operation: DnrHeaderOperation
  readonly value?: string
}

export interface DnrQueryKeyValue {
  readonly key: string
  readonly value: string
  readonly replaceOnly?: boolean
}

export interface DnrQueryTransform {
  readonly addOrReplaceParams?: readonly DnrQueryKeyValue[]
  readonly removeParams?: readonly string[]
}

export interface DnrUrlTransform {
  readonly scheme?: string
  readonly host?: string
  readonly port?: string
  readonly path?: string
  readonly query?: string
  readonly queryTransform?: DnrQueryTransform
  readonly fragment?: string
  readonly username?: string
  readonly password?: string
}

export interface DnrRedirect {
  readonly url?: string
  readonly extensionPath?: string
  readonly regexSubstitution?: string
  readonly transform?: DnrUrlTransform
}

export interface DnrAction {
  readonly type: DnrActionType
  readonly redirect?: DnrRedirect
  readonly requestHeaders?: readonly DnrHeaderInfo[]
  readonly responseHeaders?: readonly DnrHeaderInfo[]
}

export type DnrDomainType = "firstParty" | "thirdParty"

export interface DnrCondition {
  readonly urlFilter?: string
  readonly regexFilter?: string
  readonly isUrlFilterCaseSensitive?: boolean
  readonly resourceTypes?: readonly DnrResourceType[]
  readonly excludedResourceTypes?: readonly DnrResourceType[]
  /** Lower-case domains; the deprecated `domains` key folds into this one. */
  readonly initiatorDomains?: readonly string[]
  readonly excludedInitiatorDomains?: readonly string[]
  readonly requestDomains?: readonly string[]
  readonly excludedRequestDomains?: readonly string[]
  readonly domainType?: DnrDomainType
  /** Lower-case HTTP methods. */
  readonly requestMethods?: readonly string[]
  readonly excludedRequestMethods?: readonly string[]
  readonly tabIds?: readonly number[]
  readonly excludedTabIds?: readonly number[]
}

export interface DnrRule {
  readonly id: number
  readonly priority: number
  readonly action: DnrAction
  readonly condition: DnrCondition
}

export class DnrRuleError extends Error {
  constructor(where: string, reason: string) {
    super(`${where}: ${reason}`)
    this.name = "DnrRuleError"
  }
}

/** Chrome refuses regular expressions that would not fit its RE2 budget. */
const MAX_REGEX_LENGTH = 2048

type Json = Record<string, unknown>

const ACTION_TYPES: ReadonlySet<string> = new Set([
  "block", "allow", "allowAllRequests", "upgradeScheme", "redirect", "modifyHeaders"
])
const HEADER_OPERATIONS: ReadonlySet<string> = new Set(["append", "set", "remove"])
const RESOURCE_TYPES: ReadonlySet<string> = new Set(DNR_RESOURCE_TYPES)
const FRAME_TYPES: ReadonlySet<string> = new Set(["main_frame", "sub_frame"])

function isObject(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** The record without its undefined entries, so optional keys stay absent. */
function compact<T>(record: Record<string, unknown>): T {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as T
}

function fail(where: string, reason: string): never {
  throw new DnrRuleError(where, reason)
}

function optionalString(json: Json, key: string, where: string): string | undefined {
  const value = json[key]
  if (value === undefined) return undefined
  if (typeof value !== "string") fail(where, `"${key}" must be a string`)
  return value
}

function optionalStringList(json: Json, key: string, where: string): string[] | undefined {
  const value = json[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    fail(where, `"${key}" must be a list of strings`)
  }
  if (value.length === 0) fail(where, `"${key}" must not be empty`)
  return value
}

function optionalNumberList(json: Json, key: string, where: string): number[] | undefined {
  const value = json[key]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || !value.every((item) => Number.isInteger(item))) {
    fail(where, `"${key}" must be a list of integers`)
  }
  return value
}

function domainList(json: Json, key: string, where: string): string[] | undefined {
  const list = optionalStringList(json, key, where)
  return list?.map((domain) => {
    if (domain.length === 0 || /[^\x21-\x7e]/.test(domain)) {
      fail(where, `"${key}" has an invalid domain "${domain}"`)
    }
    return domain.toLowerCase()
  })
}

function resourceTypeList(json: Json, key: string, where: string): DnrResourceType[] | undefined {
  const list = optionalStringList(json, key, where)
  for (const type of list ?? []) {
    if (!RESOURCE_TYPES.has(type)) fail(where, `"${key}" has an unknown resource type "${type}"`)
  }
  return list as DnrResourceType[] | undefined
}

/**
 * Whether a `regexFilter` is one the matcher accepts, in the shape
 * `isRegexSupported` answers with. A syntax error and an oversized pattern
 * are the two reasons the browsers give.
 */
export function isRegexSupported(
  regex: string,
  options: { isCaseSensitive?: boolean; requireCapturing?: boolean } = {}
): { isSupported: boolean; reason?: "syntaxError" | "memoryLimitExceeded" } {
  if (regex.length > MAX_REGEX_LENGTH) return { isSupported: false, reason: "memoryLimitExceeded" }
  try {
    new RegExp(regex, options.isCaseSensitive === false ? "i" : "")
  } catch {
    return { isSupported: false, reason: "syntaxError" }
  }
  return { isSupported: true }
}

function condition(value: unknown, where: string): DnrCondition {
  if (value === undefined) return {}
  if (!isObject(value)) fail(where, '"condition" must be an object')
  const urlFilter = optionalString(value, "urlFilter", where)
  const regexFilter = optionalString(value, "regexFilter", where)
  if (urlFilter !== undefined && regexFilter !== undefined) {
    fail(where, "urlFilter and regexFilter cannot both be set")
  }
  if (urlFilter !== undefined && /[^\x20-\x7e]/.test(urlFilter)) {
    fail(where, "urlFilter must be ASCII; use punycode for international domains")
  }
  const caseSensitive = value.isUrlFilterCaseSensitive
  if (caseSensitive !== undefined && typeof caseSensitive !== "boolean") {
    fail(where, '"isUrlFilterCaseSensitive" must be a boolean')
  }
  if (regexFilter !== undefined) {
    const support = isRegexSupported(regexFilter, { isCaseSensitive: caseSensitive !== false })
    if (!support.isSupported) fail(where, `regexFilter is not supported (${support.reason})`)
  }
  const resourceTypes = resourceTypeList(value, "resourceTypes", where)
  const excludedResourceTypes = resourceTypeList(value, "excludedResourceTypes", where)
  if (resourceTypes && excludedResourceTypes?.some((type) => resourceTypes.includes(type))) {
    fail(where, "resourceTypes and excludedResourceTypes overlap")
  }
  const domainType = value.domainType
  if (domainType !== undefined && domainType !== "firstParty" && domainType !== "thirdParty") {
    fail(where, '"domainType" must be "firstParty" or "thirdParty"')
  }
  // `domains`/`excludedDomains` are the older names of the initiator lists.
  const initiatorDomains = domainList(value, "initiatorDomains", where) ?? domainList(value, "domains", where)
  const excludedInitiatorDomains = domainList(value, "excludedInitiatorDomains", where) ??
    domainList(value, "excludedDomains", where)
  const methods = (key: string) => optionalStringList(value, key, where)?.map((method) => method.toLowerCase())
  return compact<DnrCondition>({
    urlFilter, regexFilter,
    isUrlFilterCaseSensitive: caseSensitive as boolean | undefined,
    resourceTypes, excludedResourceTypes,
    initiatorDomains, excludedInitiatorDomains,
    requestDomains: domainList(value, "requestDomains", where),
    excludedRequestDomains: domainList(value, "excludedRequestDomains", where),
    domainType: domainType as DnrDomainType | undefined,
    requestMethods: methods("requestMethods"),
    excludedRequestMethods: methods("excludedRequestMethods"),
    tabIds: optionalNumberList(value, "tabIds", where),
    excludedTabIds: optionalNumberList(value, "excludedTabIds", where)
  })
}

function headerList(value: unknown, key: string, where: string): DnrHeaderInfo[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length === 0) fail(where, `"${key}" must be a non-empty list`)
  return value.map((entry, index) => {
    const at = `${where}.${key}[${index}]`
    if (!isObject(entry)) fail(at, "must be an object")
    const header = entry.header
    if (typeof header !== "string" || header.length === 0 || /[^\x21-\x7e]|:/.test(header)) {
      fail(at, "needs a valid header name")
    }
    const operation = entry.operation
    if (typeof operation !== "string" || !HEADER_OPERATIONS.has(operation)) {
      fail(at, "needs an operation of append, set or remove")
    }
    const hasValue = entry.value !== undefined
    if (operation === "remove" && hasValue) fail(at, "a remove operation takes no value")
    if (operation !== "remove" && typeof entry.value !== "string") {
      fail(at, `a ${operation} operation needs a string value`)
    }
    const info: DnrHeaderInfo = { header, operation: operation as DnrHeaderOperation }
    return hasValue ? { ...info, value: entry.value as string } : info
  })
}

function transform(value: unknown, where: string): DnrUrlTransform {
  if (!isObject(value)) fail(where, '"transform" must be an object')
  const result: Record<string, unknown> = {}
  for (const key of ["scheme", "host", "port", "path", "query", "fragment", "username", "password"]) {
    const entry = optionalString(value, key, where)
    if (entry !== undefined) result[key] = entry
  }
  if (typeof result.query === "string" && result.query.length > 0 && !result.query.startsWith("?")) {
    fail(where, 'transform.query must start with "?"')
  }
  if (typeof result.fragment === "string" && result.fragment.length > 0 && !result.fragment.startsWith("#")) {
    fail(where, 'transform.fragment must start with "#"')
  }
  if (typeof result.scheme === "string" && !/^[a-z][a-z0-9+.-]*$/i.test(result.scheme)) {
    fail(where, "transform.scheme is not a scheme")
  }
  if (value.queryTransform !== undefined) {
    if (result.query !== undefined) fail(where, "transform.query and transform.queryTransform cannot both be set")
    const query = value.queryTransform
    if (!isObject(query)) fail(where, "transform.queryTransform must be an object")
    const params = query.addOrReplaceParams
    const added = params === undefined ? undefined : (Array.isArray(params) ? params : [null]).map((param) => {
      if (!isObject(param) || typeof param.key !== "string" || typeof param.value !== "string") {
        fail(where, "addOrReplaceParams entries need a key and a value")
      }
      return { key: param.key, value: param.value, replaceOnly: param.replaceOnly === true }
    })
    const removed = query.removeParams
    if (removed !== undefined && (!Array.isArray(removed) || !removed.every((key) => typeof key === "string"))) {
      fail(where, "removeParams must be a list of strings")
    }
    result.queryTransform = { addOrReplaceParams: added, removeParams: removed }
  }
  return result as DnrUrlTransform
}

function redirect(value: unknown, where: string, hasRegex: boolean): DnrRedirect {
  if (!isObject(value)) fail(where, "a redirect action needs a redirect object")
  const url = optionalString(value, "url", where)
  const extensionPath = optionalString(value, "extensionPath", where)
  const regexSubstitution = optionalString(value, "regexSubstitution", where)
  const given = [url, extensionPath, regexSubstitution, value.transform].filter((entry) => entry !== undefined)
  if (given.length !== 1) {
    fail(where, "redirect needs exactly one of url, extensionPath, regexSubstitution or transform")
  }
  if (url !== undefined) {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === "javascript:") throw new Error("javascript")
    } catch {
      fail(where, `redirect.url "${url}" is not an absolute URL`)
    }
  }
  if (extensionPath !== undefined && !extensionPath.startsWith("/")) {
    fail(where, 'redirect.extensionPath must start with "/"')
  }
  if (regexSubstitution !== undefined && !hasRegex) {
    fail(where, "regexSubstitution needs a regexFilter condition")
  }
  return compact<DnrRedirect>({
    url, extensionPath, regexSubstitution,
    transform: value.transform === undefined ? undefined : transform(value.transform, where)
  })
}

function action(value: unknown, where: string, cond: DnrCondition): DnrAction {
  if (!isObject(value)) fail(where, '"action" must be an object')
  const type = value.type
  if (typeof type !== "string" || !ACTION_TYPES.has(type)) fail(where, '"action.type" is not a known action')
  const result: { -readonly [K in keyof DnrAction]: DnrAction[K] } = { type: type as DnrActionType }
  if (type === "redirect") {
    result.redirect = redirect(value.redirect, where, cond.regexFilter !== undefined)
  } else if (type === "modifyHeaders") {
    result.requestHeaders = headerList(value.requestHeaders, "requestHeaders", where)
    result.responseHeaders = headerList(value.responseHeaders, "responseHeaders", where)
    if (!result.requestHeaders && !result.responseHeaders) {
      fail(where, "modifyHeaders needs requestHeaders or responseHeaders")
    }
  } else if (type === "allowAllRequests") {
    const types = cond.resourceTypes
    if (!types || !types.every((entry) => FRAME_TYPES.has(entry))) {
      fail(where, "allowAllRequests needs resourceTypes of only main_frame and sub_frame")
    }
  }
  return result
}

export function parseDnrRule(value: unknown, where = "rule"): DnrRule {
  if (!isObject(value)) fail(where, "must be an object")
  const id = value.id
  if (!Number.isInteger(id) || (id as number) < 1) fail(where, '"id" must be a positive integer')
  const priority = value.priority ?? 1
  if (!Number.isInteger(priority) || (priority as number) < 1) {
    fail(where, '"priority" must be a positive integer')
  }
  const at = `${where} ${id}`
  const cond = condition(value.condition, at)
  return { id: id as number, priority: priority as number, action: action(value.action, at, cond), condition: cond }
}

export function parseDnrRules(value: unknown, where = "rules"): DnrRule[] {
  if (!Array.isArray(value)) fail(where, "must be a list of rules")
  return value.map((entry, index) => parseDnrRule(entry, `${where}[${index}]`))
}
