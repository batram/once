// `browser.*` methods that need the main process. The preload forwards
// `{api, method, args}`; this table answers. Synchronous APIs such as
// `runtime.getURL` and `i18n.getMessage` live in the preload instead.

import { app } from "electron"
import { getLocaleMessage } from "@once/core"
import { ExtensionContexts, ContextEntry, EventTarget } from "./ExtensionContexts"
import { ExtensionPorts } from "./ExtensionPorts"
import { extensionUrl } from "./ExtensionScheme"
import { ExtensionStorage } from "./ExtensionStorage"
import { LoadedExtension } from "./LoadedExtension"
import { ContentScript, ExtensionFiles } from "./contentScripts"
import {
  contentScriptHandlers,
  cookieHandlers,
  inertHandlers,
  permissionHandlers
} from "./apiExtras"
import { INTERNAL_API } from "./protocol"
import { ExtensionShellHooks, TabSnapshot, TabUpdateProps, platformOs } from "./runtimeTypes"

const MESSAGE_REPLY_TIMEOUT_MS = 30_000
const SCRIPT_RESULT_TIMEOUT_MS = 10_000

export interface ApiHost {
  readonly extension: LoadedExtension
  readonly contexts: ExtensionContexts
  readonly ports: ExtensionPorts
  readonly storage: ExtensionStorage
  readonly files: ExtensionFiles
  readonly hooks: ExtensionShellHooks
  readonly action: BrowserActionState
  readonly alarms: AlarmScheduler
  readonly cookies: Electron.Cookies
  readonly registeredScripts: Map<number, ContentScript>
  registerContentScript(script: ContentScript): number
}

export interface ApiCall {
  host: ApiHost
  sender: ContextEntry
}

export type ApiHandler = (call: ApiCall, ...args: unknown[]) => unknown

type Handlers = Record<string, ApiHandler>

export interface BrowserActionSnapshot {
  title: string | null
  badgeText: string
  badgeBackgroundColor: string | null
  enabled: boolean
}

/** Per-tab overrides on top of the global browser action state. */
export class BrowserActionState {
  private global: BrowserActionSnapshot
  private readonly perTab = new Map<number, Partial<BrowserActionSnapshot>>()
  private listener: (() => void) | null = null

  constructor(defaultTitle: string | null) {
    this.global = { title: defaultTitle, badgeText: "", badgeBackgroundColor: null, enabled: true }
  }

  onChanged(listener: () => void): void {
    this.listener = listener
  }

  snapshot(tabId?: number): BrowserActionSnapshot {
    const overrides = tabId === undefined ? undefined : this.perTab.get(tabId)
    return { ...this.global, ...overrides }
  }

  update(tabId: number | undefined, patch: Partial<BrowserActionSnapshot>): void {
    if (tabId === undefined) {
      this.global = { ...this.global, ...patch }
    } else {
      this.perTab.set(tabId, { ...this.perTab.get(tabId), ...patch })
    }
    this.listener?.()
  }

  forgetTab(tabId: number): void {
    this.perTab.delete(tabId)
  }
}

interface AlarmInfo {
  name: string
  scheduledTime: number
  periodInMinutes?: number
}

interface AlarmOptions {
  when?: number
  delayInMinutes?: number
  periodInMinutes?: number
}

/** `browser.alarms`, kept in main so a throttled background page still fires. */
export class AlarmScheduler {
  private readonly alarms = new Map<string, { info: AlarmInfo; timer: NodeJS.Timeout }>()

  constructor(private readonly fire: (alarm: AlarmInfo) => void) {}

  create(name: string, options: AlarmOptions): void {
    this.clear(name)
    const delayMs = typeof options.when === "number"
      ? Math.max(0, options.when - Date.now())
      : Math.max(0, (options.delayInMinutes ?? options.periodInMinutes ?? 0) * 60_000)
    const info: AlarmInfo = { name, scheduledTime: Date.now() + delayMs }
    if (typeof options.periodInMinutes === "number") info.periodInMinutes = options.periodInMinutes
    const schedule = (ms: number): NodeJS.Timeout => setTimeout(() => {
      const current = this.alarms.get(name)
      if (!current) return
      this.fire(current.info)
      if (info.periodInMinutes !== undefined) {
        info.scheduledTime = Date.now() + info.periodInMinutes * 60_000
        current.timer = schedule(info.periodInMinutes * 60_000)
      } else {
        this.alarms.delete(name)
      }
    }, ms)
    this.alarms.set(name, { info, timer: schedule(delayMs) })
  }

  clear(name: string): boolean {
    const existing = this.alarms.get(name)
    if (!existing) return false
    clearTimeout(existing.timer)
    this.alarms.delete(name)
    return true
  }

  clearAll(): void {
    for (const name of [...this.alarms.keys()]) this.clear(name)
  }

  get(name: string): AlarmInfo | undefined {
    return this.alarms.get(name)?.info
  }

  getAll(): AlarmInfo[] {
    return [...this.alarms.values()].map((alarm) => alarm.info)
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? value as Record<string, unknown> : {}
}

function optionalTabId(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined
}

function requireTabId(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("A tab id is required")
  }
  return value
}

function requireTab(host: ApiHost, id: number): TabSnapshot {
  const tab = host.hooks.tabs().find((candidate) => candidate.id === id)
  if (!tab) throw new Error(`Invalid tab ID: ${id}`)
  return tab
}

function activeTabId(host: ApiHost): number {
  const active = host.hooks.tabs().find((tab) => tab.active)
  if (!active) throw new Error("There is no active tab")
  return active.id
}

// tabs.query URL filters are match patterns without the scheme restrictions,
// so a glob is the honest reading.
function urlGlobMatches(pattern: string, url: string): boolean {
  if (pattern === "<all_urls>") return true
  const escaped = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")
  return new RegExp(`^${escaped}$`).test(url)
}

function queryTabs(host: ApiHost, info: Record<string, unknown>): TabSnapshot[] {
  const urls = typeof info.url === "string" ? [info.url] : Array.isArray(info.url) ? info.url : null
  return host.hooks.tabs().filter((tab) => {
    if (typeof info.active === "boolean" && tab.active !== info.active) return false
    if (typeof info.windowId === "number" && tab.windowId !== info.windowId) return false
    if (typeof info.audible === "boolean" && tab.audible !== info.audible) return false
    if (typeof info.muted === "boolean" && tab.mutedInfo.muted !== info.muted) return false
    if (typeof info.status === "string" && tab.status !== info.status) return false
    return !urls || urls.some(
      (pattern) => typeof pattern === "string" && urlGlobMatches(pattern, tab.url)
    )
  })
}

function frameDescriptor(tab: TabSnapshot): Record<string, unknown> {
  return { url: tab.url, frameId: 0, parentFrameId: -1, tabId: tab.id, errorOccurred: false }
}

function windowSnapshot(host: ApiHost, id: number): Record<string, unknown> {
  const tabs = host.hooks.tabs().filter((tab) => tab.windowId === id)
  return {
    id, focused: true, incognito: false, type: "normal", state: "normal", alwaysOnTop: false, tabs
  }
}

/** `MessageSender`: who sent a message or opened a port. */
export function senderDescriptor(host: ApiHost, sender: ContextEntry): Record<string, unknown> {
  const descriptor: Record<string, unknown> = {
    id: host.extension.id,
    url: sender.url(),
    frameId: sender.frameId
  }
  if (sender.kind === "content") {
    descriptor.tab = host.hooks.tabs().find((tab) => tab.id === sender.tabId)
  }
  return descriptor
}

function substitutionList(value: unknown): string[] {
  if (value === undefined) return []
  return Array.isArray(value) ? value.map(String) : [String(value)]
}

async function firstReply(host: ApiHost, targets: EventTarget[], args: unknown[]): Promise<unknown> {
  for (const target of targets) {
    const results = await host.contexts.request(
      target, "runtime", "onMessage", args, MESSAGE_REPLY_TIMEOUT_MS
    )
    const reply = results.find((result) => result !== undefined)
    if (reply !== undefined) return reply
  }
  return undefined
}

/** The content-script contexts of one tab, optionally one frame of it. */
function frameContexts(host: ApiHost, tabId: number, frameId?: number, allFrames = false): ContextEntry[] {
  return host.contexts.all().filter((entry) =>
    entry.kind === "content" && entry.tabId === tabId && !entry.isDestroyed() &&
    (frameId !== undefined ? entry.frameId === frameId : allFrames || entry.frameId === 0)
  )
}

function runtimeHandlers(): Handlers {
  return {
    "runtime.getPlatformInfo": () => ({
      os: platformOs(process.platform),
      arch: process.arch === "x64" ? "x86-64" : process.arch === "ia32" ? "x86-32" : process.arch
    }),
    "runtime.getBrowserInfo": () => ({
      name: "Firefox",
      vendor: "Mozilla",
      version: "128.0",
      buildID: "20240101000000"
    }),
    // Reaches the extension's pages, never its content scripts (Firefox).
    "runtime.sendMessage": ({ host, sender }, message) => firstReply(
      host,
      host.contexts.targets("runtime", "onMessage", (_spec, entry) => entry.kind !== "content", sender.id),
      [message, senderDescriptor(host, sender)]
    ),
    "runtime.openOptionsPage": async ({ host }) => {
      const options = host.extension.manifest.optionsUi
      if (!options) throw new Error("This extension has no options page")
      await host.hooks.createTab(extensionUrl(host.extension.host, options.page), true)
    },
    "runtime.reload": () => undefined,
    "runtime.setUninstallURL": () => undefined,
    "extension.isAllowedIncognitoAccess": () => false,
    "management.getSelf": ({ host }) => ({
      id: host.extension.id,
      name: host.extension.name,
      shortName: host.extension.name,
      description: host.extension.description,
      version: host.extension.manifest.version,
      enabled: true,
      type: "extension",
      installType: "development",
      mayDisable: false,
      optionsUrl: host.extension.manifest.optionsUi
        ? extensionUrl(host.extension.host, host.extension.manifest.optionsUi.page)
        : "",
      permissions: [...host.extension.manifest.permissions],
      hostPermissions: [...host.extension.manifest.hostPermissions]
    }),
    "i18n.getMessage": ({ host }, key, substitutions) =>
      typeof key === "string"
        ? getLocaleMessage(host.extension.messages, key, substitutionList(substitutions))
        : "",
    "i18n.getUILanguage": () => app.getLocale(),
    "i18n.getAcceptLanguages": () => [app.getLocale()]
  }
}

function storageHandlers(): Handlers {
  const announce = (host: ApiHost, changes: Record<string, unknown>): void => {
    if (Object.keys(changes).length > 0) {
      host.contexts.emit("storage", "onChanged", [changes, "local"])
    }
  }
  return {
    "storage.local.get": ({ host }, keys) => host.storage.get(keys ?? null),
    "storage.local.set": async ({ host }, items) => announce(host, await host.storage.set(items)),
    "storage.local.remove": async ({ host }, keys) => announce(host, await host.storage.remove(keys)),
    "storage.local.clear": async ({ host }) => announce(host, await host.storage.clear()),
    "storage.local.getBytesInUse": ({ host }, keys) => host.storage.getBytesInUse(keys ?? null),
    "webRequest.handlerBehaviorChanged": () => undefined
  }
}

function tabHandlers(): Handlers {
  return {
    "tabs.query": ({ host }, info) => queryTabs(host, asRecord(info)),
    "tabs.get": ({ host }, id) => requireTab(host, requireTabId(id)),
    "tabs.getCurrent": ({ host, sender }) =>
      sender.kind === "content" ? requireTab(host, sender.tabId) : undefined,
    "tabs.create": ({ host }, props) => {
      const { url, active } = asRecord(props)
      return host.hooks.createTab(typeof url === "string" ? url : "about:blank", active !== false)
    },
    "tabs.update": ({ host }, first, second) => {
      const hasId = typeof first === "number"
      const id = hasId ? first : activeTabId(host)
      const props = asRecord(hasId ? second : first)
      const update: TabUpdateProps = {}
      if (typeof props.url === "string") update.url = props.url
      if (typeof props.active === "boolean") update.active = props.active
      if (typeof props.muted === "boolean") update.muted = props.muted
      return host.hooks.updateTab(id, update)
    },
    // Windows are not crossed: `windowId` is accepted and ignored.
    "tabs.move": async ({ host }, ids, props) => {
      const { index } = asRecord(props)
      const target = typeof index === "number" ? index : -1
      const moved: unknown[] = []
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        moved.push(await host.hooks.moveTab(requireTabId(id), target))
      }
      return Array.isArray(ids) ? moved : moved[0]
    },
    "tabs.remove": async ({ host }, ids) => {
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        await host.hooks.removeTab(requireTabId(id))
      }
    },
    "tabs.reload": ({ host }, id) =>
      host.hooks.reloadTab(typeof id === "number" ? id : activeTabId(host)),
    "tabs.sendMessage": ({ host, sender }, tabId, message, options) => {
      const { frameId } = asRecord(options)
      const targets = host.contexts.targets("runtime", "onMessage", (_spec, entry) =>
        entry.kind === "content" && entry.tabId === requireTabId(tabId) &&
        (typeof frameId !== "number" || entry.frameId === frameId)
      )
      if (targets.length === 0) {
        throw new Error("Could not establish connection. Receiving end does not exist.")
      }
      return firstReply(host, targets, [message, senderDescriptor(host, sender)])
    },
    "tabs.captureVisibleTab": () => {
      throw new Error("tabs.captureVisibleTab is not available")
    },
    "webNavigation.getFrame": ({ host }, details) => {
      const { tabId, frameId } = asRecord(details)
      const tab = requireTab(host, requireTabId(tabId))
      return frameId === 0 ? frameDescriptor(tab) : null
    },
    "webNavigation.getAllFrames": ({ host }, details) =>
      [frameDescriptor(requireTab(host, requireTabId(asRecord(details).tabId)))],
    "windows.get": ({ host }, id) => windowSnapshot(host, requireTabId(id)),
    "windows.getCurrent": ({ host }) => {
      const tabs = host.hooks.tabs()
      const active = tabs.find((tab) => tab.active) ?? tabs[0]
      return active
        ? windowSnapshot(host, active.windowId)
        : { id: -1, focused: false, type: "normal" }
    },
    "windows.getAll": ({ host }) =>
      [...new Set(host.hooks.tabs().map((tab) => tab.windowId))]
        .map((id) => windowSnapshot(host, id)),
    "windows.create": async ({ host }, props) => {
      const { url } = asRecord(props)
      const first = Array.isArray(url) ? url[0] : url
      const tab = await host.hooks.createTab(typeof first === "string" ? first : "about:blank", true)
      return tab ? windowSnapshot(host, tab.windowId) : null
    },
    "windows.update": () => undefined
  }
}

/** tabs.executeScript, insertCSS, removeCSS: reach into a tab's frames. */
function injectionHandlers(): Handlers {
  interface Injection {
    tabId: number
    frames: ContextEntry[]
    details: Record<string, unknown>
    code: string
  }
  const resolve = (host: ApiHost, first: unknown, second: unknown, key: "code" | "css"): Injection => {
    const hasId = typeof first === "number"
    const tabId = hasId ? first : activeTabId(host)
    const details = asRecord(hasId ? second : first)
    const code = typeof details[key === "css" ? "code" : "code"] === "string"
      ? details.code as string
      : typeof details.file === "string" ? host.files.read(details.file) : null
    if (code === null) throw new Error("Either code or file is required")
    const frames = frameContexts(host, tabId, optionalTabId(details.frameId), details.allFrames === true)
    return { tabId, frames, details, code }
  }
  return {
    "tabs.executeScript": async ({ host }, first, second) => {
      const { frames, details, code } = resolve(host, first, second, "code")
      const url = typeof details.file === "string" ? extensionUrl(host.extension.host, details.file) : undefined
      const results: unknown[] = []
      for (const frame of frames) {
        const [result] = await host.contexts.request(
          { entry: frame, listenerIds: [] },
          INTERNAL_API.content, "executeScript", [{ code, url }], SCRIPT_RESULT_TIMEOUT_MS
        )
        results.push(result)
      }
      return results
    },
    "tabs.insertCSS": ({ host }, first, second) => {
      const { frames, code } = resolve(host, first, second, "css")
      for (const frame of frames) {
        frame.send({ api: INTERNAL_API.content, event: "insertCSS", args: [{ css: code }] })
      }
    },
    "tabs.removeCSS": ({ host }, first, second) => {
      const { frames, code } = resolve(host, first, second, "css")
      for (const frame of frames) {
        frame.send({ api: INTERNAL_API.content, event: "removeCSS", args: [{ css: code }] })
      }
    }
  }
}

function actionHandlers(): Handlers {
  const patch = (
    key: keyof BrowserActionSnapshot,
    read: (details: Record<string, unknown>) => BrowserActionSnapshot[typeof key]
  ): ApiHandler => ({ host }, details) => {
    const record = asRecord(details)
    host.action.update(optionalTabId(record.tabId), { [key]: read(record) })
  }
  return {
    "browserAction.setIcon": () => undefined,
    "browserAction.setTitle": patch("title", ({ title }) => typeof title === "string" ? title : null),
    "browserAction.getTitle": ({ host }, details) =>
      host.action.snapshot(optionalTabId(asRecord(details).tabId)).title ?? "",
    "browserAction.setBadgeText": patch("badgeText", ({ text }) => typeof text === "string" ? text : ""),
    "browserAction.getBadgeText": ({ host }, details) =>
      host.action.snapshot(optionalTabId(asRecord(details).tabId)).badgeText,
    "browserAction.setBadgeBackgroundColor": patch(
      "badgeBackgroundColor",
      ({ color }) => typeof color === "string" ? color : null
    ),
    "browserAction.setBadgeTextColor": () => undefined,
    "browserAction.setPopup": () => undefined,
    "browserAction.enable": ({ host }, tabId) =>
      host.action.update(optionalTabId(tabId), { enabled: true }),
    "browserAction.disable": ({ host }, tabId) =>
      host.action.update(optionalTabId(tabId), { enabled: false }),
    "contextMenus.create": (_call, props) => asRecord(props).id ?? `menu-${Date.now()}`,
    "contextMenus.update": () => undefined,
    "contextMenus.remove": () => undefined,
    "contextMenus.removeAll": () => undefined,
    "menus.create": (_call, props) => asRecord(props).id ?? `menu-${Date.now()}`,
    "menus.update": () => undefined,
    "menus.remove": () => undefined,
    "menus.removeAll": () => undefined,
    "alarms.create": ({ host }, first, second) => {
      const name = typeof first === "string" ? first : ""
      host.alarms.create(name, asRecord(typeof first === "string" ? second : first) as AlarmOptions)
    },
    "alarms.clear": ({ host }, name) => host.alarms.clear(typeof name === "string" ? name : ""),
    "alarms.clearAll": ({ host }) => {
      host.alarms.clearAll()
      return true
    },
    "alarms.get": ({ host }, name) => host.alarms.get(typeof name === "string" ? name : ""),
    "alarms.getAll": ({ host }) => host.alarms.getAll()
  }
}

/** `runtime.connect` / `tabs.connect` and the port traffic that follows. */
function portHandlers(): Handlers {
  return {
    [`${INTERNAL_API.port}.connect`]: ({ host, sender }, details) => {
      const { name, tabId, frameId } = asRecord(details)
      return host.ports.connect(
        sender,
        typeof name === "string" ? name : "",
        { tabId: optionalTabId(tabId), frameId: optionalTabId(frameId) },
        senderDescriptor(host, sender)
      )
    },
    [`${INTERNAL_API.port}.post`]: ({ host, sender }, details) => {
      const { portId, message } = asRecord(details)
      if (typeof portId === "number") host.ports.post(sender.id, portId, message)
    },
    [`${INTERNAL_API.port}.disconnect`]: ({ host, sender }, details) => {
      const { portId } = asRecord(details)
      if (typeof portId === "number") host.ports.disconnect(sender.id, portId)
    }
  }
}

export function createApiHandlers(): Handlers {
  return {
    ...runtimeHandlers(),
    ...storageHandlers(),
    ...tabHandlers(),
    ...injectionHandlers(),
    ...actionHandlers(),
    ...portHandlers(),
    ...cookieHandlers(),
    ...contentScriptHandlers(),
    ...permissionHandlers(),
    ...inertHandlers()
  }
}
