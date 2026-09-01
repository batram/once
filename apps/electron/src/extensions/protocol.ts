// The contract between the main-process extension runtime and the preload
// that builds `browser.*` inside extension pages. Kept free of Electron
// imports so the preload bundle and unit tests can share it.

import { LocaleMessages } from "@once/core"

export const EXTENSION_SCHEME = "once-ext"

export const EXTENSION_IPC = {
  /** Renderer → main, `ipcRenderer.invoke`: one API call. */
  invoke: "once-ext:invoke",
  /** Renderer → main, `ipcRenderer.invoke`: what this page is and may do. */
  init: "once-ext:init",
  /** Main → renderer: an API event, optionally expecting a reply. */
  event: "once-ext:event",
  /** Renderer → main, `ipcRenderer.send`: the reply to an event with a token. */
  reply: "once-ext:reply"
} as const

export type ExtensionContextKind = "background" | "popup" | "options" | "page"

export interface ExtensionContextInit {
  id: string
  host: string
  kind: ExtensionContextKind
  /** The manifest exactly as it was on disk, for `runtime.getManifest()`. */
  manifest: unknown
  messages: LocaleMessages
  uiLanguage: string
}

export interface ExtensionInvoke {
  api: string
  method: string
  args: unknown[]
}

export interface ExtensionEvent {
  api: string
  event: string
  args: unknown[]
  /** Present when main waits for the listeners' result. */
  token?: number
}

export interface ExtensionReply {
  token: number
  result: unknown
}

/**
 * Every namespace the preload materialises, with the methods it forwards to
 * main and the events main can raise. A method or event missing here does
 * not exist in the extension's `browser` object, which is how the runtime
 * stays an allowlist rather than a general implementation.
 */
export const EXTENSION_API_SURFACE: Readonly<Record<string, {
  readonly methods: readonly string[]
  readonly events: readonly string[]
}>> = {
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
      "sendMessage", "executeScript", "insertCSS", "removeCSS", "captureVisibleTab"
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
