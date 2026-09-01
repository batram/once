// The contract between the main-process extension runtime and the preloads
// that build `browser.*` inside extension pages and content-script worlds.
// Kept free of Electron imports so the preload bundles and unit tests can
// share it.

import { ContentScriptRunAt, LocaleMessages } from "@once/core"

export const EXTENSION_SCHEME = "once-ext"

export const EXTENSION_IPC = {
  /** Extension page → main, `ipcRenderer.invoke`: one API call. */
  invoke: "once-ext:invoke",
  /** Extension page → main, `sendSync`: what this page is and may do. */
  init: "once-ext:init",
  /** Main → any context: an API event, optionally expecting a reply. */
  event: "once-ext:event",
  /** Extension page → main, `ipcRenderer.send`: the reply to an event with a token. */
  reply: "once-ext:reply",
  /** Tab frame → main, `sendSync`: which content scripts run here. */
  contentInit: "once-ext:content-init",
  /** Tab frame → main, `ipcRenderer.invoke`: one API call from a content script. */
  contentInvoke: "once-ext:content-invoke",
  /** Tab frame → main, `ipcRenderer.send`: a content script's reply. */
  contentReply: "once-ext:content-reply"
} as const

export type ExtensionContextKind = "background" | "popup" | "options" | "page" | "content"

export interface ExtensionContextInit {
  id: string
  host: string
  kind: ExtensionContextKind
  /** The manifest exactly as it was on disk, for `runtime.getManifest()`. */
  manifest: unknown
  messages: LocaleMessages
  uiLanguage: string
}

export interface ContentScriptBatch {
  runAt: ContentScriptRunAt
  js: { url: string; code: string }[]
  css: string[]
}

/** One extension's share of a frame: its identity plus what to inject. */
export interface ContentFrameInit extends ExtensionContextInit {
  /** The isolated world this extension's content scripts run in. */
  worldId: number
  scripts: ContentScriptBatch[]
}

export interface ExtensionInvoke {
  api: string
  method: string
  args: unknown[]
  /** Set by content-script contexts, which share a frame between extensions. */
  host?: string
}

export interface ExtensionEvent {
  api: string
  event: string
  args: unknown[]
  /** Present when main waits for the listeners' result. */
  token?: number
  /** Which registered listeners to run; all when absent. */
  listeners?: number[]
  /** Set for content-script contexts so the frame routes to one extension. */
  host?: string
}

export interface ExtensionReply {
  token: number
  result: unknown
  host?: string
}

/** Internal API namespaces the preloads use; never exposed to pages. */
export const INTERNAL_API = {
  listeners: "__listeners",
  port: "__port",
  content: "__content"
} as const

export interface ApiSurface {
  readonly methods: readonly string[]
  readonly events: readonly string[]
}

/**
 * Every namespace the extension-page preload materialises, with the methods
 * it forwards to main and the events main can raise. A method or event
 * missing here does not exist in the extension's `browser` object, which is
 * how the runtime stays an allowlist rather than a general implementation.
 */
export const EXTENSION_API_SURFACE: Readonly<Record<string, ApiSurface>> = {
  runtime: {
    methods: [
      "getURL", "getManifest", "getPlatformInfo", "getBrowserInfo",
      "sendMessage", "openOptionsPage", "reload", "setUninstallURL"
    ],
    events: ["onMessage", "onInstalled", "onStartup", "onConnect", "onUpdateAvailable"]
  },
  "storage.local": {
    methods: ["get", "set", "remove", "clear", "getBytesInUse"],
    events: []
  },
  storage: { methods: [], events: ["onChanged"] },
  webRequest: {
    methods: ["handlerBehaviorChanged"],
    events: [
      "onBeforeRequest", "onBeforeSendHeaders", "onSendHeaders", "onHeadersReceived",
      "onResponseStarted", "onBeforeRedirect", "onErrorOccurred", "onCompleted"
    ]
  },
  tabs: {
    methods: [
      "query", "get", "getCurrent", "create", "update", "remove", "reload",
      "sendMessage", "connect", "executeScript", "insertCSS", "removeCSS", "captureVisibleTab"
    ],
    events: ["onCreated", "onUpdated", "onRemoved", "onActivated", "onReplaced"]
  },
  webNavigation: {
    methods: ["getFrame", "getAllFrames"],
    events: [
      "onBeforeNavigate", "onCommitted", "onDOMContentLoaded", "onCompleted",
      "onCreatedNavigationTarget"
    ]
  },
  windows: {
    methods: ["get", "getCurrent", "getAll", "create", "update"],
    events: ["onFocusChanged"]
  },
  i18n: {
    methods: ["getMessage", "getUILanguage", "getAcceptLanguages"],
    events: []
  },
  browserAction: {
    methods: [
      "setIcon", "setTitle", "getTitle", "setBadgeText", "getBadgeText",
      "setBadgeBackgroundColor", "setBadgeTextColor", "setPopup", "enable", "disable"
    ],
    events: ["onClicked"]
  },
  extension: { methods: ["getURL", "isAllowedIncognitoAccess"], events: [] },
  contextMenus: { methods: ["create", "update", "remove", "removeAll"], events: ["onClicked"] },
  menus: { methods: ["create", "update", "remove", "removeAll"], events: ["onClicked"] },
  management: { methods: ["getSelf"], events: [] },
  alarms: { methods: ["create", "clear", "clearAll", "get", "getAll"], events: ["onAlarm"] }
}

/** What a content script may reach: messaging, storage, and i18n. */
export const CONTENT_API_SURFACE: Readonly<Record<string, ApiSurface>> = {
  runtime: {
    methods: ["getURL", "getManifest", "sendMessage"],
    events: ["onMessage", "onConnect"]
  },
  "storage.local": {
    methods: ["get", "set", "remove", "clear", "getBytesInUse"],
    events: []
  },
  storage: { methods: [], events: ["onChanged"] },
  i18n: { methods: ["getMessage", "getUILanguage"], events: [] },
  extension: { methods: ["getURL"], events: [] }
}

/**
 * `privacy.*` entries are settings objects with get/set/clear, not methods.
 * Values are Firefox defaults; nothing here is controllable from an extension.
 */
export const PRIVACY_SETTINGS: Readonly<Record<string, Readonly<Record<string, unknown>>>> = {
  network: {
    networkPredictionEnabled: true,
    webRTCIPHandlingPolicy: "default",
    peerConnectionEnabled: true,
    httpsOnlyMode: "never",
    globalPrivacyControl: false
  },
  websites: {
    hyperlinkAuditingEnabled: true,
    firstPartyIsolate: false,
    resistFingerprinting: false,
    trackingProtectionMode: "private_browsing",
    cookieConfig: { behavior: "reject_trackers", nonPersistentCookies: false }
  },
  services: {
    passwordSavingEnabled: true
  }
}
