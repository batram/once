// The JSON protocol between Java and the Once Lite broker, and between the
// broker and the scripts it injects into extension pages and content worlds.
// `docs/plans/once-lite-broker-protocol.md` is the prose version; the shapes
// here are the contract. Everything crosses a WebMessage channel or a
// DevTools binding as a JSON string, so every type is plain data.

import { ExtensionContextInit, ExtensionEvent, ExtensionInvokeResult, ListenerChange } from "@once/webext-runtime/preload"

/** The `WebMessageListener` object Java injects into the broker page. */
export const BROKER_CHANNEL = "onceLite"
/** The synchronous `JavascriptInterface` for extension files and bundled scripts. */
export const FILES_INTERFACE = "onceLiteFiles"
/** The `WebMessageListener` object Java injects into extension page frames. */
export const PAGE_CHANNEL = "onceLitePage"
/** The DevTools binding content worlds call; one per `once-ext:<host>` world. */
export const WORLD_BINDING = "onceLiteWorld"
/** The DevTools binding Once's own bridge world calls; Java handles it directly. */
export const BRIDGE_BINDING = "onceLiteBridge"
/** The function the broker has Java evaluate in a world to deliver a message. */
export const WORLD_DELIVER = "__onceLiteDeliver"
/** The function Java evaluates in the bridge world to deliver a message. */
export const BRIDGE_DELIVER = "__onceLiteBridgeDeliver"
/** The pseudo directory `onceLiteFiles.read` answers the built bundles for. */
export const BUNDLE_DIRECTORY = "@bundle"
/** Where extension pages load: `https://<host>.moz-extension.localhost/...`. */
export const PAGE_HOST_SUFFIX = ".moz-extension.localhost"
export const WORLD_PREFIX = "once-ext:"

// ---------------------------------------------------------------------------
// Envelope: both directions carry requests (answered by id), responses and
// fire-and-forget events.

export interface RequestEnvelope {
  type: "request"
  id: number
  method: string
  params?: unknown
}

export interface ResponseEnvelope {
  type: "response"
  id: number
  result?: unknown
  error?: string
  /** A machine-readable reason beside the message, such as `NOT_RUNNING`. */
  code?: string
}

export interface EventEnvelope {
  type: "event"
  event: string
  params?: unknown
}

export type Envelope = RequestEnvelope | ResponseEnvelope | EventEnvelope

// ---------------------------------------------------------------------------
// Java → broker requests.

export interface BundledExtensionParam {
  id: string
  /** The directory `onceLiteFiles.read` resolves paths against. */
  directory: string
  present: boolean
}

export interface StartParams {
  bundled: BundledExtensionParam[]
  locale: string
  arch: string
  /**
   * The broker's secret, held by the extension worlds too: document nonces
   * and the keys of the synchronous answers derive from it. Never in a
   * page's main world.
   */
  token: string
  /**
   * The token of the event channel the main-world helper shares with Once's
   * bridge world and the content worlds (`wrappedJSObject`). A page can
   * watch that channel, so this is no secret.
   */
  channel?: string
  /** Where the manager and each extension keep their JSON documents. */
  storageRoot: string
  /** Whether Java holds a usable DevTools connection; false is Tier 2. */
  devtools?: boolean
  /** uBlock Origin Lite's bundle (Tier 2 only; its id is `UBOLITE_ID`). */
  ubolite?: BundledExtensionParam
}

// ---------------------------------------------------------------------------
// Tier 2 (no DevTools): Java evaluates the rules and installs the page
// scripts itself; the broker compiles both from the synced documents.

/** The catalogue id of the bundled uBlock Origin Lite (its Safari manifest carries none). */
export const UBOLITE_ID = "uBOLite@raymondhill.net"
export const TIER2_DISABLED_REASON = "Extensions limited: DevTools unavailable"

/**
 * One extension's rules for Java's evaluator. Groups decide independently
 * and a block from any group wins, as one extension's allow rule does not
 * lift another's block in Chrome. Static rulesets are named by path and read
 * by Java from `directory` (uBO Lite's run to 100k rules; they never cross
 * the channel).
 */
export interface NetRuleGroup {
  id: string
  /** `onceLiteFiles.read`'s directory for `rulesets` and `redirect.extensionPath`. */
  directory?: string
  /** Package-relative JSON files, each an array of DNR rules. */
  rulesets?: string[]
  /** Inline rules (dynamic, session, converted lists). */
  rules: unknown[]
}

export interface NetRulesParams {
  groups: NetRuleGroup[]
}

export interface NetRulesResult {
  /** Rules Java compiled per group, static and inline. */
  counts: Record<string, number>
  /** Rules Java could not compile (an unsupported regex, say). */
  skipped?: number
}

export interface Tier2ScriptsParams {
  /** Page-world sources, each registered on its own with `addDocumentStartJavaScript`. */
  sources: string[]
}

export interface Tier2FetchListResult {
  status: number
  text?: string
}

export interface SessionRulesParams {
  addRules?: unknown
  removeRuleIds?: unknown
}

export interface StartResult {
  ready: true
  /** The extensions loaded at start, as the catalogue lists them. */
  extensions: CatalogEntry[]
}

/** `MobileBrowserExtension` from `@once/platform-mobile`, repeated so the broker needs no shell import. */
export interface CatalogEntry {
  id: string
  name: string
  iconDataUrl?: string
  description: string
  version: string
  enabled: boolean
  bundled: boolean
  hasOptions: boolean
  hasAction: boolean
  permissions: string[]
  disabledReason: string
}

export interface ExtensionCommandParams {
  action: "list" | "install" | "chooseFile" | "enable" | "remove" | "update" | "options" | "action"
  id?: string
  source?: string
  enabled?: boolean
  /** For `chooseFile`: the picked file as Java names it (a content URI or path). */
  file?: string
}

export interface ExtensionCommandResult {
  extensions?: CatalogEntry[]
  cancelled?: boolean
  noPage?: boolean
}

export interface TabState {
  tabId: number
  /** The surface's generation of this tab; a new generation is a new tab to extensions. */
  generation: number
  /** The DevTools target of the tab's WebView, once attached. */
  targetId?: string
  url: string
  title: string
  active: boolean
  index: number
  status: "loading" | "complete"
  audible: boolean
  muted: boolean
}

export type TargetKind = "tab" | "page" | "broker"

export interface TargetAttachedParams {
  targetId: string
  kind: TargetKind
  tabId?: number
  pageId?: string
  /** `Page.getFrameTree` taken right after attaching, so frames that exist already are known. */
  frameTree?: CdpFrameTree
}

export interface CdpFrame {
  id: string
  parentId?: string
  url: string
}

export interface CdpFrameTree {
  frame: CdpFrame
  childFrames?: CdpFrameTree[]
}

/** A DevTools event Java forwards verbatim, with the target it came from. */
export interface CdpEventParams {
  targetId: string
  method: string
  params: unknown
}

export interface PageMessageParams {
  pageId: string
  /** Java's monotonic document-context id; mainFrame identifies the main document separately. */
  frameId: number
  mainFrame: boolean
  url: string
  /** The page bootstrap's message, already parsed. */
  message: PageToBrokerMessage
}

export interface PageLifecycleParams {
  pageId: string
  url?: string
}

export interface ViolentmonkeySendParams {
  cmd: string
  data?: unknown
}

export interface SettingsParams {
  filterLists: unknown
  userscripts: unknown
}

export interface TimerFiredParams {
  timerId: number
}

export interface CookieChangedParams {
  removed: boolean
  cookie: unknown
  cause: string
}

// ---------------------------------------------------------------------------
// Broker → Java requests and events.

export interface CdpCommandParams {
  targetId: string
  method: string
  params?: unknown
}

export interface WorldRegistration {
  /** Java keys installed scripts by this: `<worldName>` for the bootstrap, `<worldName>#dynamic` for registered scripts. */
  id: string
  worldName: string
  /**
   * Installed with `Page.addScriptToEvaluateOnNewDocument {source, worldName}`;
   * `runImmediately` only when a target is first attached (a later change
   * reaches new documents only, as on Electron).
   */
  source: string
  /** `Runtime.addBinding {name, executionContextName: worldName}`, once per world. */
  binding: string
}

export interface WorldsSetParams {
  /** The full set for every tab target; Java removes what is no longer listed. */
  registrations: WorldRegistration[]
  /**
   * The page bootstrap for frames of tab WebViews at an extension's origin
   * (uBlock's element picker): `addDocumentStartJavaScript(source, [origin])`.
   */
  pages: TabPageRegistration[]
}

export interface TabPageRegistration {
  host: string
  origin: string
  documentStartSource: string
}

export interface PageOpenParams {
  pageId: string
  kind: "background" | "popup" | "options" | "page"
  host: string
  /** The https form of the page URL. */
  url: string
  /** The origin the page channel and document-start script are restricted to. */
  origin: string
  /** `WebViewCompat.addDocumentStartJavaScript(source, [origin])`. */
  documentStartSource: string
}

export interface PagePostParams {
  pageId: string
  frameId: number
  message: BrokerToPageMessage
}

export interface PageResizeParams {
  pageId: string
  width: number
  height: number
}

export interface TabCreateParams {
  url: string
  active: boolean
}

export interface TabUpdateParams {
  tabId: number
  url?: string
  active?: boolean
  muted?: boolean
}

export interface StoreReadParams {
  directory: string
  name: string
}

/** A value too large for one message travels beforehand through `onceLiteFiles.writeChunk(token, text)`. */
export type StoreValue = string | { chunked: string }

export interface StoreWriteParams extends StoreReadParams {
  json: StoreValue
}

/** `store.read`: the text, or a token to read it through `onceLiteFiles.readChunk(token)`. */
export interface StoreReadResult {
  json: string | null
  chunked?: string
}

/**
 * A partial write: Java merges `set` (key → JSON text of the value) and
 * `remove` into the document on disk. uBlock's storage.json runs to tens of
 * megabytes, so whole-document writes would cross the channel dozens of
 * times during a list reload.
 */
export interface StorePatchParams extends StoreReadParams {
  set: Record<string, StoreValue>
  remove: string[]
}

export interface ConfirmParams {
  title: string
  message: string
  detail: string
  confirmLabel: string
  cancelLabel: string
}

export interface FetchResult {
  status: number
  headers: Record<string, string>
  bodyBase64: string
}

export interface UnzipResult {
  entries: { name: string; isDirectory: boolean; size: number }[]
}

/**
 * An answer Java serves itself, from memory, to a content world's
 * synchronous request at `https://<host>.moz-extension.localhost<path>`:
 * every WebView shares one renderer main thread, so a request that blocks
 * a tab can never be answered by the broker. The broker prepares these
 * before a document continues, one per document and extension, under a
 * path only that document's worlds can name (`dynamicAnswerPath`,
 * `blobAnswerPath`). Java serves each body once, in the order stored.
 */
export interface SyncAnswerParams {
  targetId: string
  frameId: string
  host: string
  path: string
  /** The JSON text to serve, or null to forget the answers under the path. */
  body: string | null
}

export interface LogParams {
  level: "log" | "warn" | "error"
  message: string
}

// ---------------------------------------------------------------------------
// Broker ↔ extension page (over `onceLitePage`).

export type PageToBrokerMessage = (
  | { type: "invoke"; id: number; api: string; method: string; args: unknown[] }
  | { type: "listen"; change: ListenerChange }
  | { type: "reply"; token: number; result: unknown[] }
  | { type: "popup-size"; width: number; height: number }
) & {
  /** The frame's `location.href` (https form); Java reports only the origin of subframes. */
  href?: string
}

/** Internal event the broker sends an extension page: read one of its blob URLs. */
export const BLOB_API = "__liteBlob"
/** Every synchronous answer lives under this path of the extension's origin; Java answers it, never the broker. */
export const SYNC_PATH = "/_once/"

/** A document's URL as the synchronous answers name it: no fragment. */
export function syncDocumentUrl(documentUrl: string): string {
  return documentUrl.split("#")[0]
}

/**
 * Where a content world asks, synchronously at document start, for what the
 * broker prepared for its document: the extension's registered scripts that
 * match it, `executeScript` calls queued for it, Violentmonkey's cookie.
 * `key` is `syncKey(token, url)`, which only the broker and the worlds can
 * compute, so a page can name the answer for no other document than its own.
 */
export function dynamicAnswerPath(key: string, documentUrl: string): string {
  return `${SYNC_PATH}${key}/dynamic?u=${encodeURIComponent(syncDocumentUrl(documentUrl))}`
}

/** Where a content world's request for the extension's `blob:` URL is routed (see `mapBlobUrl`). */
export function blobAnswerPath(key: string, blobId: string, documentUrl: string): string {
  return `${SYNC_PATH}${key}/blob/${blobId}?u=${encodeURIComponent(syncDocumentUrl(documentUrl))}`
}

export type BrokerToPageMessage =
  | { type: "result"; id: number; result: ExtensionInvokeResult }
  | { type: "event"; message: ExtensionEvent }

/** What the page bootstrap finds in `window.__onceLitePageInit` at document start. */
export type PageInit = ExtensionContextInit

// ---------------------------------------------------------------------------
// Broker ↔ content world (over the `onceLiteWorld` binding and `__onceLiteDeliver`).

export type WorldToBrokerMessage =
  | { host: string; type: "hello"; url: string; topUrl: string; creatorUrl: string; matched: boolean }
  | { host: string; type: "invoke"; id: number; api: string; method: string; args: unknown[] }
  | { host: string; type: "listen"; change: ListenerChange }
  | { host: string; type: "reply"; token: number; result: unknown[] }
  /** A scriptlet the page's `<meta>` policy refused; the broker runs it in the main world. */
  | { host: string; type: "main-eval"; code: string }

export type BrokerToWorldMessage =
  | { type: "result"; id: number; result: ExtensionInvokeResult }
  | { type: "event"; message: ExtensionEvent }

/** The static configuration a world bootstrap is compiled with. */
export interface WorldConfig {
  init: ExtensionContextInit
  /** `StartParams.token`: the nonce and the keys of the world's synchronous requests. */
  token: string
  /** `StartParams.channel`: the main-world helper's event channel. */
  channel: string
  /** The manifest's content scripts, matched inside the world. */
  scripts: WorldScript[]
}

/**
 * Scripts registered at run time (`contentScripts.register`, `scripting`)
 * that match the document. A world asks for them with a synchronous
 * request to `<extension origin>` + `dynamicAnswerPath` at document start,
 * which Java answers from what the broker prepared at the document's
 * response stage, so uBlock's scriptlets (registered during the document's
 * held `onResponseStarted`) run before the page's own scripts. A DevTools
 * command on the target would deadlock while its navigation is paused, so
 * nothing is installed that way.
 */
export interface WorldDynamicConfig {
  host: string
  scripts: WorldScript[]
  /**
   * A cookie the world sets on its document at document start (`name=value`),
   * for the one answer prepared per document: Violentmonkey's content script
   * finds the blob id of its injection there, since a `Set-Cookie` added to
   * the response through DevTools is not stored by Chromium.
   */
  cookie?: string
}

export interface WorldScript {
  matches: string[]
  excludeMatches: string[]
  allFrames: boolean
  matchAboutBlank: boolean
  runAt: "document_start" | "document_end" | "document_idle"
  world: "MAIN" | "ISOLATED"
  js: { url: string; code: string }[]
  css: string[]
}

// ---------------------------------------------------------------------------
// URL mapping shared by both sides: `moz-extension://<host>/p` is what the
// extension sees, `https://<host>.moz-extension.localhost/p` is where the
// WebView actually loads it.

export function pageUrlFromExtensionUrl(url: string): string {
  let parsed: URL
  try { parsed = new URL(url) } catch { return url }
  if (parsed.protocol !== "moz-extension:" || !parsed.hostname) return url
  return `https://${parsed.hostname}${PAGE_HOST_SUFFIX}${parsed.pathname}${parsed.search}${parsed.hash}`
}

export function extensionUrlFromPageUrl(url: string): string {
  const host = pageHostOf(url)
  if (host === null) return url
  const parsed = new URL(url)
  return `moz-extension://${host}${parsed.pathname}${parsed.search}${parsed.hash}`
}

/** The extension host of a page URL in either form, or null for an ordinary URL. */
export function pageHostOf(url: string): string | null {
  let parsed: URL
  try { parsed = new URL(url) } catch { return null }
  if (parsed.protocol === "moz-extension:") return parsed.hostname || null
  if (parsed.protocol !== "https:") return null
  const hostname = parsed.hostname.toLowerCase()
  if (!hostname.endsWith(PAGE_HOST_SUFFIX)) return null
  const host = hostname.slice(0, -PAGE_HOST_SUFFIX.length)
  return host && !host.includes(".") ? host : null
}

export function pageOrigin(host: string): string {
  return `https://${host}${PAGE_HOST_SUFFIX}`
}

export function worldNameFor(host: string): string {
  return `${WORLD_PREFIX}${host}`
}

// ---------------------------------------------------------------------------
// DevTools `Fetch.requestPaused.resourceType` → the names Electron's
// webRequest reports, which `webExtResourceType` in the runtime understands.

const CDP_RESOURCE_TYPES: Readonly<Record<string, string>> = {
  Stylesheet: "stylesheet",
  Image: "image",
  Media: "media",
  Font: "font",
  Script: "script",
  TextTrack: "other",
  XHR: "xhr",
  Fetch: "xhr",
  Prefetch: "other",
  EventSource: "other",
  WebSocket: "webSocket",
  Manifest: "other",
  SignedExchange: "other",
  Ping: "ping",
  CSPViolationReport: "cspReport",
  Preflight: "other",
  Other: "other"
}

/** `Document` is a main or sub frame depending on where it loads. */
export function electronResourceType(cdpType: string, isTopFrame: boolean): string {
  if (cdpType === "Document") return isTopFrame ? "mainFrame" : "subFrame"
  return CDP_RESOURCE_TYPES[cdpType] ?? "other"
}
