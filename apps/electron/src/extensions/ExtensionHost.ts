import path from "node:path"
import { BrowserWindow, Session, WebContents, session as electronSession } from "electron"
import { MatchPatternSet } from "@once/core"
import { ExtensionContexts } from "./ExtensionContexts"
import { AlarmScheduler, ApiHost, BrowserActionState } from "./ExtensionApi"
import { configureExtensionProtocol } from "./ExtensionProtocol"
import { extensionUrl } from "./ExtensionScheme"
import { ExtensionStorage } from "./ExtensionStorage"
import { LoadedExtension } from "./LoadedExtension"
import { ExtensionContextKind } from "./protocol"
import { ExtensionShellHooks } from "./runtimeTypes"

// uBlock decides which browser it is running in from the user agent as well
// as from `runtime.getBrowserInfo`, so extension pages present as Firefox.
const EXTENSION_PAGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0"

export interface ExtensionHostOptions {
  extension: LoadedExtension
  storageRoot: string
  preloadPath: string
  hooks: ExtensionShellHooks
  lookup: (host: string) => LoadedExtension | undefined
}

/**
 * One loaded extension: its own session partition, its background page,
 * storage, and the pages it has open. The browser session's webRequest hooks
 * live in the runtime and consult every host in turn.
 */
export class ExtensionHost implements ApiHost {
  readonly extension: LoadedExtension
  readonly contexts = new ExtensionContexts()
  readonly storage: ExtensionStorage
  readonly hooks: ExtensionShellHooks
  readonly action: BrowserActionState
  readonly alarms: AlarmScheduler
  readonly session: Session
  private backgroundWindow: BrowserWindow | null = null

  constructor(private readonly options: ExtensionHostOptions) {
    this.extension = options.extension
    this.hooks = options.hooks
    this.storage = new ExtensionStorage(
      path.join(options.storageRoot, this.extension.host, "storage.json")
    )
    this.action = new BrowserActionState(this.extension.manifest.browserAction?.defaultTitle ?? null)
    this.alarms = new AlarmScheduler((alarm) => this.contexts.emit("alarms", "onAlarm", [alarm]))
    this.session = electronSession.fromPartition(`persist:once-ext:${this.extension.host}`)
  }

  /** Serves the extension's files to its own pages and starts the background page. */
  async start(): Promise<void> {
    configureExtensionProtocol(this.session, this.options.lookup)
    this.session.setUserAgent(EXTENSION_PAGE_USER_AGENT)
    this.session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    this.grantCrossOriginReads()
    const page = this.extension.backgroundPage
    if (!page) return
    const window = new BrowserWindow({
      show: false,
      webPreferences: this.webPreferences()
    })
    this.backgroundWindow = window
    this.register(window.webContents, "background")
    // Errors and warnings always reach the main log; set
    // ONCE_ELECTRON_EXTENSION_LOG=1 to see everything an extension prints.
    window.webContents.on("console-message", (event) => {
      if (event.level === "error" || event.level === "warning") {
        console.error(`[${this.extension.name}]`, event.message)
      } else if (process.env.ONCE_ELECTRON_EXTENSION_LOG === "1") {
        console.log(`[${this.extension.name}]`, event.message)
      }
    })
    await window.loadURL(extensionUrl(this.extension.host, page))
    this.contexts.emit("runtime", "onStartup", [])
  }

  /**
   * Firefox lets extension pages read cross-origin responses from any host
   * they hold a permission for; uBlock downloads its filter lists that way.
   * This session carries only the extension's own requests, so answering
   * with permissive CORS headers for permitted hosts is the same grant.
   */
  private grantCrossOriginReads(): void {
    const permitted = new MatchPatternSet(this.extension.manifest.hostPermissions)
    if (permitted.size === 0) return
    const origin = extensionUrl(this.extension.host, "/").slice(0, -1)
    this.session.webRequest.onHeadersReceived({ urls: ["<all_urls>"] }, (details, callback) => {
      if (!/^https?:/.test(details.url) || !permitted.matches(details.url)) {
        callback({})
        return
      }
      const headers: Record<string, string | string[]> = {}
      for (const [name, value] of Object.entries(details.responseHeaders ?? {})) {
        if (!name.toLowerCase().startsWith("access-control-")) headers[name] = value
      }
      headers["Access-Control-Allow-Origin"] = origin
      headers["Access-Control-Allow-Credentials"] = "true"
      headers["Access-Control-Allow-Headers"] = "*"
      headers["Access-Control-Allow-Methods"] = "*"
      headers["Access-Control-Expose-Headers"] = "*"
      callback({ responseHeaders: headers })
    })
  }

  private webPreferences(): Electron.WebPreferences {
    return {
      preload: this.options.preloadPath,
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      session: this.session
    }
  }

  /** A page of this extension the shell opened (popup, options, dashboard). */
  register(contents: WebContents, kind: ExtensionContextKind): void {
    this.contexts.add(contents, kind)
  }

  async dispose(): Promise<void> {
    this.alarms.clearAll()
    this.contexts.dispose()
    if (this.backgroundWindow && !this.backgroundWindow.isDestroyed()) {
      this.backgroundWindow.destroy()
    }
    this.backgroundWindow = null
    await this.storage.flush()
  }
}
