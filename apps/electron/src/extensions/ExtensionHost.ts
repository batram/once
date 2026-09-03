import { promises as fs } from "node:fs"
import path from "node:path"
import { Session, WebContents, WebContentsView, session as electronSession } from "electron"
import { MatchPatternSet } from "@once/core"
import { ExtensionContexts } from "./ExtensionContexts"
import { AlarmScheduler, ApiHost, BrowserActionState } from "./ExtensionApi"
import { ExtensionPorts } from "./ExtensionPorts"
import { configureExtensionProtocol } from "./ExtensionProtocol"
import { extensionUrl } from "./ExtensionScheme"
import { ExtensionStorage } from "./ExtensionStorage"
import { LoadedExtension, mimeTypeFor, resolveExtensionFile } from "./LoadedExtension"
import { ContentScript, ExtensionFiles, manifestContentScripts } from "./contentScripts"
import { ExtensionContextKind } from "./protocol"
import { ExtensionShellHooks, PageProfile } from "./runtimeTypes"

// uBlock decides which browser it is running in from the user agent as well
// as from `runtime.getBrowserInfo`, so extension pages present as Firefox.
const EXTENSION_PAGE_USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:128.0) Gecko/20100101 Firefox/128.0"

export interface ExtensionHostOptions {
  extension: LoadedExtension
  storageRoot: string
  preloadPath: string
  worldId: number
  /** The browser session's cookie jar, for `browser.cookies`. */
  cookies: Electron.Cookies
  hooks: ExtensionShellHooks
  lookup: (host: string) => LoadedExtension | undefined
}

/**
 * One loaded extension: its own session partition, its background page,
 * storage, files, ports, and the contexts it runs in. The browser session's
 * webRequest hooks live in the runtime and consult every host in turn.
 */
export class ExtensionHost implements ApiHost {
  readonly extension: LoadedExtension
  readonly contexts = new ExtensionContexts()
  readonly ports: ExtensionPorts
  readonly storage: ExtensionStorage
  readonly files: ExtensionFiles
  readonly hooks: ExtensionShellHooks
  readonly action: BrowserActionState
  readonly alarms: AlarmScheduler
  readonly session: Session
  readonly worldId: number
  readonly cookies: Electron.Cookies
  /** `contentScripts.register` entries, by the id handed back. */
  readonly registeredScripts = new Map<number, ContentScript>()
  private nextScriptId = 1
  private backgroundView: WebContentsView | null = null
  private icon: Promise<string | null> | null = null

  constructor(private readonly options: ExtensionHostOptions) {
    this.extension = options.extension
    this.hooks = options.hooks
    this.worldId = options.worldId
    this.cookies = options.cookies
    this.storage = new ExtensionStorage(
      path.join(options.storageRoot, this.extension.host, "storage.json")
    )
    this.files = new ExtensionFiles(this.extension)
    this.ports = new ExtensionPorts(this.contexts)
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
    // A view attached to nothing, not a hidden BrowserWindow: a window would
    // count in `BrowserWindow.getAllWindows()`, keep the app alive after the
    // last shell window closes, and be what tests and menus find first.
    const view = new WebContentsView({ webPreferences: this.webPreferences() })
    this.backgroundView = view
    const contents = view.webContents
    this.register(contents, "background")
    // Errors and warnings always reach the main log; set
    // ONCE_ELECTRON_EXTENSION_LOG=1 to see everything an extension prints.
    contents.on("console-message", (event) => {
      if (event.level === "error" || event.level === "warning") {
        console.error(`[${this.extension.name}]`, event.message)
      } else if (process.env.ONCE_ELECTRON_EXTENSION_LOG === "1") {
        console.log(`[${this.extension.name}]`, event.message)
      }
    })
    await contents.loadURL(extensionUrl(this.extension.host, page))
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

  /** How any page of this extension must be created, wherever it is shown. */
  webPreferences(): Electron.WebPreferences {
    return {
      preload: this.options.preloadPath,
      nodeIntegration: false,
      // The preload must also run in iframes that show the extension's own
      // pages; it grants no Node access, the page stays sandboxed.
      nodeIntegrationInSubFrames: true,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      backgroundThrottling: false,
      session: this.session
    }
  }

  profile(): PageProfile {
    return { session: this.session, preload: this.options.preloadPath }
  }

  /** Manifest content scripts first, then whatever the background registered. */
  contentScripts(): ContentScript[] {
    return [
      ...manifestContentScripts(this.extension.manifest.contentScripts),
      ...this.registeredScripts.values()
    ]
  }

  registerContentScript(script: ContentScript): number {
    const id = this.nextScriptId++
    this.registeredScripts.set(id, script)
    return id
  }

  /** A page of this extension the shell opened (popup, options, dashboard). */
  register(contents: WebContents, kind: ExtensionContextKind): void {
    this.contexts.add(contents, kind)
  }

  popupUrl(): string | null {
    const popup = this.extension.manifest.browserAction?.defaultPopup
    return popup ? extensionUrl(this.extension.host, popup) : null
  }

  /** The largest toolbar icon at or under 32px, as a data URL. */
  iconDataUrl(): Promise<string | null> {
    this.icon ??= (async () => {
      const icons = {
        ...this.extension.manifest.icons,
        ...this.extension.manifest.browserAction?.defaultIcon
      }
      const sizes = Object.keys(icons)
        .map(Number)
        .filter((size) => Number.isFinite(size) && size <= 32)
        .sort((a, b) => b - a)
      const chosen = sizes[0] !== undefined ? icons[String(sizes[0])] : icons.default
      const file = chosen ? resolveExtensionFile(this.extension, chosen) : null
      if (!file) return null
      try {
        const body = await fs.readFile(file)
        return `data:${mimeTypeFor(file)};base64,${body.toString("base64")}`
      } catch {
        return null
      }
    })()
    return this.icon
  }

  async dispose(): Promise<void> {
    this.alarms.clearAll()
    this.contexts.dispose()
    const contents = this.backgroundView?.webContents
    if (contents && !contents.isDestroyed()) contents.close()
    this.backgroundView = null
    await this.storage.flush()
  }
}
