// One loaded extension on Lite: the `ApiHost` the shared handlers see, over
// Java-backed storage, files and cookies. The background page is a hidden
// WebView Java opens on request (`page.open` kind `background`); its
// contexts and those of popups, options pages and content worlds are kept
// in `LiteExtensionContexts`.

import {
  AlarmScheduler,
  ApiHost,
  BrowserActionState,
  ContentScript,
  CookieStore,
  DnrRulesets,
  ExtensionFiles,
  ExtensionPorts,
  ExtensionStorage,
  JsonStore,
  LoadedExtension,
  RuntimePlatform,
  TabSnapshot,
  extensionIconDataUrl,
  extensionUrl,
  manifestContentScripts
} from "@once/webext-runtime"
import { JavaChannel } from "./javaChannel"
import { LiteExtensionContexts } from "./liteContexts"
import { LiteTabs } from "./liteTabs"

export interface LiteExtensionHostOptions {
  extension: LoadedExtension
  store: JsonStore
  channel: JavaChannel
  cookies: CookieStore
  platform: RuntimePlatform
  hooks: LiteTabs
  /** Content scripts changed (`contentScripts.register`, `scripting.*`): the world registrations need rebuilding. */
  onScriptsChanged(): void
  /** Opens one of this extension's pages in a WebView; answers its page id. */
  openPage(host: LiteExtensionHost, kind: "background" | "popup" | "options" | "page", url: string): Promise<string>
  closePage(pageId: string): Promise<void>
}

export class LiteExtensionHost implements ApiHost {
  readonly extension: LoadedExtension
  readonly contexts: LiteExtensionContexts
  readonly ports: ExtensionPorts
  readonly storage: ExtensionStorage
  readonly syncStorage: ExtensionStorage
  readonly store: JsonStore
  readonly files: ExtensionFiles
  readonly hooks: LiteTabs
  readonly action: BrowserActionState
  readonly alarms: AlarmScheduler
  readonly cookies: CookieStore
  readonly platform: RuntimePlatform
  readonly dnr: DnrRulesets
  readonly registeredScripts: Map<number, ContentScript>
  private readonly activeTabGrants = new Map<number, string>()
  private nextScriptId = 1
  private backgroundPageId: string | null = null
  private icon: Promise<string | null> | null = null

  constructor(private readonly options: LiteExtensionHostOptions) {
    this.extension = options.extension
    this.hooks = options.hooks
    this.cookies = options.cookies
    this.platform = options.platform
    this.store = options.store
    this.contexts = new LiteExtensionContexts(options.channel)
    this.storage = new ExtensionStorage(this.store, "storage.json")
    this.syncStorage = new ExtensionStorage(this.store, "sync.json")
    this.dnr = new DnrRulesets(this.extension, this.store, "dnr.json")
    this.files = new ExtensionFiles(this.extension)
    this.ports = new ExtensionPorts(this.contexts)
    this.action = new BrowserActionState(this.extension.manifest.browserAction?.defaultTitle ?? null)
    this.alarms = new AlarmScheduler((alarm) => this.contexts.emit("alarms", "onAlarm", [alarm]))
    this.registeredScripts = new Proxy(new Map<number, ContentScript>(), {
      get: (target, property) => {
        const value = Reflect.get(target, property, target)
        if (property === "delete") {
          return (key: number) => {
            const removed = target.delete(key)
            if (removed) options.onScriptsChanged()
            return removed
          }
        }
        return typeof value === "function" ? value.bind(target) : value
      }
    })
  }

  get backgroundPage(): string | null {
    return this.backgroundPageId
  }

  grantActiveTab(tab: TabSnapshot | undefined): void {
    if (!tab || !this.extension.manifest.permissions.has("activeTab")) return
    try {
      const url = new URL(tab.url)
      if (url.protocol === "http:" || url.protocol === "https:") this.activeTabGrants.set(tab.id, url.origin)
    } catch { /* A blank or invalid tab has no grantable origin. */ }
  }

  revokeActiveTab(tabId: number): void {
    this.activeTabGrants.delete(tabId)
  }

  hasActiveTabGrant(tabId: number, frameUrl: string): boolean {
    const granted = this.activeTabGrants.get(tabId)
    if (!granted) return false
    try {
      return new URL(frameUrl).origin === granted &&
        new URL(this.hooks.tabs().find((tab) => tab.id === tabId)?.url ?? "").origin === granted
    } catch { return false }
  }

  /** Manifest content scripts first, then whatever the background registered. */
  contentScripts(): ContentScript[] {
    return [...manifestContentScripts(this.extension.manifest.contentScripts), ...this.registeredScripts.values()]
  }

  registerContentScript(script: ContentScript): number {
    const id = this.nextScriptId++
    this.registeredScripts.set(id, script)
    this.options.onScriptsChanged()
    return id
  }

  popupUrl(): string | null {
    const popup = this.extension.manifest.browserAction?.defaultPopup
    return popup ? extensionUrl(this.extension.host, popup) : null
  }

  optionsUrl(): string | null {
    const options = this.extension.manifest.optionsUi
    return options ? extensionUrl(this.extension.host, options.page) : null
  }

  iconDataUrl(): Promise<string | null> {
    this.icon ??= extensionIconDataUrl(this.extension)
    return this.icon
  }

  /** Static rules first, then the background page, as in Firefox. */
  async start(): Promise<void> {
    await this.dnr.load()
    const page = this.extension.backgroundPage
    if (!page) return
    this.backgroundPageId = await this.options.openPage(this, "background", extensionUrl(this.extension.host, page))
  }

  /** Called by the pages module once the background document has loaded. */
  backgroundLoaded(): void {
    this.contexts.emit("runtime", "onStartup", [])
  }

  forgetTab(tabId: number): void {
    this.revokeActiveTab(tabId)
    this.action.forgetTab(tabId)
    for (const entry of this.contexts.all()) {
      if (entry.tabId === tabId) this.contexts.remove(entry.id)
    }
  }

  async dispose(): Promise<void> {
    this.alarms.clearAll()
    this.contexts.dispose()
    if (this.backgroundPageId !== null) {
      await this.options.closePage(this.backgroundPageId).catch(() => undefined)
      this.backgroundPageId = null
    }
    await this.storage.flush()
    await this.syncStorage.flush()
    await this.dnr.flush()
  }
}
