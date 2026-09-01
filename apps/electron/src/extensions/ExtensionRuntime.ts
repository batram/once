import path from "node:path"
import {
  app,
  BrowserWindow,
  ipcMain,
  IpcMainEvent,
  IpcMainInvokeEvent,
  Session,
  WebContents,
  WebFrameMain,
  webFrameMain
} from "electron"
import { ElectronExtensionInfo, ElectronRect } from "@once/platform-electron/bridge"
import { ContentScriptSpec } from "@once/core"
import { ContextEntry, frameContextId } from "./ExtensionContexts"
import { ApiHandler, createApiHandlers } from "./ExtensionApi"
import { ExtensionHost } from "./ExtensionHost"
import { ExtensionPopup } from "./ExtensionPopup"
import { configureExtensionProtocol } from "./ExtensionProtocol"
import { LoadedExtension, loadUnpackedExtension } from "./LoadedExtension"
import { extensionUrl, parseExtensionUrl } from "./ExtensionScheme"
import { WebRequestRouter } from "./WebRequestRouter"
import { CONTENT_WORLD_BASE, contentScriptsFor } from "./contentScripts"
import {
  ApiSurface,
  CONTENT_API_SURFACE,
  ContentFrameInit,
  ContentScriptBatch,
  EXTENSION_API_SURFACE,
  EXTENSION_IPC,
  ExtensionContextInit,
  ExtensionInvoke,
  ExtensionReply,
  INTERNAL_API
} from "./protocol"
import { ExtensionShellHooks, PageProfile, TabSnapshot } from "./runtimeTypes"
import { WebRequestListenerSpec } from "./webRequestDetails"

export interface ExtensionRuntimeOptions {
  browserSession: Session
  storageRoot: string
  preloadPath: string
  contentPreloadPath: string
  hooks: ExtensionShellHooks
}

interface ListenerChange {
  api: string
  event: string
  id: number
  spec?: WebRequestListenerSpec
}

interface FrameIds {
  frameId: number
  parentFrameId: number
}

const MAIN_FRAME: FrameIds = { frameId: 0, parentFrameId: -1 }

function frameIdsOf(frame: WebFrameMain | null | undefined): FrameIds {
  try {
    if (!frame || frame.parent === null) return MAIN_FRAME
    return {
      frameId: frame.frameTreeNodeId,
      parentFrameId: frame.parent.parent === null ? 0 : frame.parent.frameTreeNodeId
    }
  } catch {
    return MAIN_FRAME
  }
}

function frameIds(isMainFrame: boolean, processId: number, routingId: number): FrameIds {
  if (isMainFrame) return MAIN_FRAME
  try {
    return frameIdsOf(webFrameMain.fromId(processId, routingId))
  } catch {
    return MAIN_FRAME
  }
}

function extensionDirectories(configured: string | undefined): string[] {
  return (configured ?? "")
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
}

/** Content scripts grouped by phase, in manifest order, as code. */
function batches(host: ExtensionHost, specs: ContentScriptSpec[]): ContentScriptBatch[] {
  const byPhase = new Map<ContentScriptBatch["runAt"], ContentScriptBatch>()
  for (const spec of specs) {
    let batch = byPhase.get(spec.runAt)
    if (!batch) {
      batch = { runAt: spec.runAt, js: [], css: [] }
      byPhase.set(spec.runAt, batch)
    }
    for (const file of spec.css) batch.css.push(host.files.read(file))
    for (const file of spec.js) {
      batch.js.push({ url: extensionUrl(host.extension.host, file), code: host.files.read(file) })
    }
  }
  return [...byPhase.values()]
}

/**
 * Loads unpacked Firefox-style extensions, hosts their pages, owns the
 * browser session's webRequest listeners and frame preload, and turns tab
 * lifecycle into `tabs` and `webNavigation` events. One instance per app.
 */
export class ExtensionRuntime {
  private readonly hosts = new Map<string, ExtensionHost>()
  private readonly contextOwner = new Map<number, ExtensionHost>()
  private readonly popups = new Map<string, ExtensionPopup>()
  private readonly handlers: Record<string, ApiHandler> = createApiHandlers()
  private readonly router: WebRequestRouter
  private readonly tabContents = new Map<number, WebContents>()
  private readonly changed = new Set<() => void>()
  private lastActive = new Map<number, number>()
  private nextWorldId = CONTENT_WORLD_BASE
  private installed = false

  constructor(private readonly options: ExtensionRuntimeOptions) {
    this.router = new WebRequestRouter(options.browserSession, {
      tabIdFor: (webContentsId) =>
        webContentsId !== undefined && this.tabContents.has(webContentsId) ? webContentsId : -1,
      sources: () => [...this.hosts.values()]
    })
  }

  install(): void {
    if (this.installed) return
    this.installed = true
    this.router.install()
    this.registerPageIpc()
    this.registerContentIpc()
    this.options.browserSession.registerPreloadScript({
      type: "frame",
      filePath: this.options.contentPreloadPath
    })
    configureExtensionProtocol(
      this.options.browserSession,
      (host) => this.hosts.get(host)?.extension,
      { webAccessibleOnly: true }
    )
    this.options.hooks.onTabCreated((contents) => this.trackTab(contents))
    this.options.hooks.onTabsChanged(() => this.tabsChanged())
    app.on("before-quit", () => {
      for (const host of this.hosts.values()) void host.storage.flush()
    })
  }

  /**
   * Loads every directory named in `ONCE_ELECTRON_EXTENSIONS`, separated
   * like PATH. A failure is logged and the others still load; there is no
   * allowlist yet, so this is the development entry point (plan step 8).
   */
  async loadConfigured(configured = process.env.ONCE_ELECTRON_EXTENSIONS): Promise<void> {
    for (const directory of extensionDirectories(configured)) {
      try {
        const extension = await this.load(directory)
        console.log(`Loaded extension ${extension.name} ${extension.manifest.version}`)
      } catch (error) {
        console.error("Extension failed to load", directory, error)
      }
    }
  }

  async load(directory: string): Promise<LoadedExtension> {
    const extension = await loadUnpackedExtension(directory, app.getLocale())
    const existing = this.hosts.get(extension.host)
    if (existing) await this.unload(extension.host)
    const host = new ExtensionHost({
      extension,
      storageRoot: this.options.storageRoot,
      preloadPath: this.options.preloadPath,
      worldId: this.nextWorldId++,
      hooks: this.options.hooks,
      lookup: (candidate) => this.hosts.get(candidate)?.extension
    })
    this.hosts.set(extension.host, host)
    host.action.onChanged(() => this.notifyChanged())
    try {
      await host.start()
    } catch (error) {
      this.hosts.delete(extension.host)
      await host.dispose()
      throw error
    }
    this.notifyChanged()
    return extension
  }

  async unload(extensionHost: string): Promise<void> {
    const host = this.hosts.get(extensionHost)
    if (!host) return
    this.hosts.delete(extensionHost)
    this.popups.get(extensionHost)?.close()
    this.popups.delete(extensionHost)
    for (const [id, owner] of this.contextOwner) {
      if (owner === host) this.contextOwner.delete(id)
    }
    await host.dispose()
    this.notifyChanged()
  }

  /** How a tab showing this URL must be created; null for ordinary pages. */
  pageProfile(url: string): PageProfile | null {
    return this.hostForUrl(url)?.profile() ?? null
  }

  /** What the shell's toolbar shows for each loaded extension. */
  async extensionInfos(activeTabId?: number): Promise<ElectronExtensionInfo[]> {
    const infos: ElectronExtensionInfo[] = []
    for (const host of this.hosts.values()) {
      const action = host.action.snapshot(activeTabId)
      infos.push({
        host: host.extension.host,
        name: host.extension.name,
        title: action.title ?? host.extension.name,
        badgeText: action.badgeText,
        badgeBackgroundColor: action.badgeBackgroundColor,
        icon: await host.iconDataUrl(),
        enabled: action.enabled,
        hasPopup: host.popupUrl() !== null
      })
    }
    return infos
  }

  /** Runs when the toolbar should re-read `extensionInfos`. */
  onChanged(listener: () => void): void {
    this.changed.add(listener)
  }

  /** The toolbar button was pressed: show the popup, or tell the extension. */
  openPopup(window: BrowserWindow, extensionHost: string, anchor: ElectronRect): void {
    const host = this.hosts.get(extensionHost)
    if (!host) throw new Error("Unknown extension")
    let popup = this.popups.get(extensionHost)
    if (popup?.isOpen()) {
      popup.close()
      return
    }
    if (!host.popupUrl()) {
      const active = this.options.hooks.tabs().find((tab) => tab.active)
      host.contexts.emit("browserAction", "onClicked", [active])
      return
    }
    if (!popup) {
      popup = new ExtensionPopup(host)
      this.popups.set(extensionHost, popup)
    }
    popup.open(window, anchor)
  }

  private notifyChanged(): void {
    for (const listener of this.changed) listener()
  }

  private hostForUrl(url: string): ExtensionHost | undefined {
    const parts = parseExtensionUrl(url)
    return parts ? this.hosts.get(parts.host) : undefined
  }

  private registerPageIpc(): void {
    // Synchronous: the preload must have `browser` ready before any page
    // script runs, so it blocks on this one answer.
    ipcMain.on(EXTENSION_IPC.init, (event) => {
      try {
        const { host, entry } = this.requireContext(event)
        const init: ExtensionContextInit = {
          id: host.extension.id,
          host: host.extension.host,
          kind: entry.kind,
          manifest: host.extension.rawManifest,
          messages: host.extension.messages,
          uiLanguage: app.getLocale()
        }
        event.returnValue = init
      } catch {
        event.returnValue = null
      }
    })
    ipcMain.handle(EXTENSION_IPC.invoke, (event, message: ExtensionInvoke) => {
      const { host, entry } = this.requireContext(event)
      return this.invoke(host, entry, message, EXTENSION_API_SURFACE)
    })
    ipcMain.on(EXTENSION_IPC.reply, (event, reply: ExtensionReply) => {
      const host = this.contextOwner.get(event.sender.id)
      if (host && typeof reply?.token === "number") {
        host.contexts.handleReply(event.sender.id, reply)
      }
    })
  }

  private registerContentIpc(): void {
    ipcMain.on(EXTENSION_IPC.contentInit, (event) => {
      try {
        event.returnValue = this.contentInit(event)
      } catch (error) {
        console.error("Content script setup failed", error)
        event.returnValue = null
      }
    })
    ipcMain.handle(EXTENSION_IPC.contentInvoke, (event, message: ExtensionInvoke) => {
      const { host, entry } = this.requireContentContext(event, message?.host)
      return this.invoke(host, entry, message, CONTENT_API_SURFACE)
    })
    ipcMain.on(EXTENSION_IPC.contentReply, (event, reply: ExtensionReply) => {
      if (typeof reply?.token !== "number" || !event.senderFrame) return
      const host = typeof reply.host === "string" ? this.hosts.get(reply.host) : undefined
      host?.contexts.handleReply(frameContextId(event.sender, event.senderFrame), reply)
    })
  }

  /**
   * A frame of a tab is starting: every extension with matching content
   * scripts gets a context in it and its scripts as code.
   */
  private contentInit(event: IpcMainEvent): ContentFrameInit[] {
    const contents = event.sender
    const frame = event.senderFrame
    if (!frame || !this.tabContents.has(contents.id)) return []
    const identity = {
      url: frame.url,
      topUrl: frame.top?.url ?? frame.url,
      isTop: frame.parent === null
    }
    const ids = frameIdsOf(frame)
    const inits: ContentFrameInit[] = []
    for (const host of this.hosts.values()) {
      const specs = contentScriptsFor(host.extension.manifest, identity)
      if (specs.length === 0) continue
      host.contexts.addFrame(contents, frame, host.extension.host, contents.id, ids.frameId)
      inits.push({
        id: host.extension.id,
        host: host.extension.host,
        kind: "content",
        manifest: host.extension.rawManifest,
        messages: host.extension.messages,
        uiLanguage: app.getLocale(),
        worldId: host.worldId,
        scripts: batches(host, specs)
      })
    }
    return inits
  }

  private requireContext(
    event: IpcMainInvokeEvent | IpcMainEvent
  ): { host: ExtensionHost; entry: ContextEntry } {
    const host = this.contextOwner.get(event.sender.id) ?? this.adoptContext(event.sender)
    const entry = host?.contexts.get(event.sender.id)
    if (!host || !entry || event.senderFrame !== event.sender.mainFrame) {
      throw new Error("Untrusted extension IPC sender")
    }
    return { host, entry }
  }

  private requireContentContext(
    event: IpcMainInvokeEvent,
    extensionHost: unknown
  ): { host: ExtensionHost; entry: ContextEntry } {
    const host = typeof extensionHost === "string" ? this.hosts.get(extensionHost) : undefined
    const frame = event.senderFrame
    const entry = host && frame && this.tabContents.has(event.sender.id)
      ? host.contexts.get(frameContextId(event.sender, frame))
      : undefined
    if (!host || !entry) throw new Error("Untrusted content script IPC sender")
    return { host, entry }
  }

  // Pages the host created register themselves; pages the shell opened at an
  // extension URL are adopted on first contact, provided they really are at
  // that URL and inside the extension's own session.
  private adoptContext(sender: WebContents): ExtensionHost | undefined {
    const url = sender.getURL()
    const host = this.hostForUrl(url)
    if (!host || sender.session !== host.session) return undefined
    if (!host.contexts.get(sender.id)) {
      const options = host.extension.manifest.optionsUi
      const isOptions = options !== null && url.startsWith(extensionUrl(host.extension.host, options.page))
      host.register(sender, isOptions ? "options" : "page")
    }
    this.contextOwner.set(sender.id, host)
    sender.once("destroyed", () => this.contextOwner.delete(sender.id))
    return host
  }

  private invoke(
    host: ExtensionHost,
    entry: ContextEntry,
    message: ExtensionInvoke,
    surface: Readonly<Record<string, ApiSurface>>
  ): unknown {
    if (!message || typeof message.api !== "string" || typeof message.method !== "string" ||
      !Array.isArray(message.args)) {
      throw new Error("Invalid extension API call")
    }
    if (message.api === INTERNAL_API.listeners) return this.listenerChange(host, entry, message, surface)
    if (message.api !== INTERNAL_API.port) {
      const known = surface[message.api]
      if (!known || !known.methods.includes(message.method)) {
        throw new Error(`browser.${message.api}.${message.method} is not available`)
      }
    }
    const handler = this.handlers[`${message.api}.${message.method}`]
    if (!handler) throw new Error(`browser.${message.api}.${message.method} is not implemented`)
    return handler({ host, sender: entry }, ...message.args)
  }

  private listenerChange(
    host: ExtensionHost,
    entry: ContextEntry,
    message: ExtensionInvoke,
    surface: Readonly<Record<string, ApiSurface>>
  ): void {
    const change = message.args[0] as ListenerChange | undefined
    if (!change || typeof change.api !== "string" || typeof change.event !== "string" ||
      typeof change.id !== "number") {
      throw new Error("Invalid listener registration")
    }
    const known = surface[change.api]
    if (!known || !known.events.includes(change.event)) {
      throw new Error(`browser.${change.api}.${change.event} is not available`)
    }
    if (message.method === "add") {
      host.contexts.addListener(entry.id, change.api, change.event, change.id, change.spec ?? null)
    } else if (message.method === "remove") {
      host.contexts.removeListener(entry.id, change.api, change.event, change.id)
    } else {
      throw new Error("Invalid listener change")
    }
  }

  /** Every host learns of the same tab event. */
  private emit(api: string, event: string, args: unknown[]): void {
    for (const host of this.hosts.values()) host.contexts.emit(api, event, args)
  }

  private snapshot(id: number): TabSnapshot | undefined {
    return this.options.hooks.tabs().find((tab) => tab.id === id)
  }

  private trackTab(contents: WebContents): void {
    const id = contents.id
    this.tabContents.set(id, contents)
    const tab = (): TabSnapshot => this.snapshot(id) ?? {
      id, windowId: -1, index: -1, url: contents.getURL(), title: contents.getTitle(),
      active: false, status: contents.isLoading() ? "loading" : "complete",
      audible: false, mutedInfo: { muted: false }, incognito: false,
      highlighted: false, pinned: false
    }
    const updated = (changeInfo: Record<string, unknown>) =>
      this.emit("tabs", "onUpdated", [id, changeInfo, tab()])
    const navigation = (
      url: string, frameId: number, parentFrameId: number
    ): Record<string, unknown> => ({
      tabId: id, url, frameId, parentFrameId, timeStamp: Date.now()
    })

    this.emit("tabs", "onCreated", [tab()])
    contents.on("did-start-loading", () => updated({ status: "loading" }))
    contents.on("did-stop-loading", () => updated({ status: "complete" }))
    contents.on("page-title-updated", (_event, title) => updated({ title }))
    contents.on("did-start-navigation", (event) => {
      if (event.isSameDocument) return
      const ids = frameIdsOf(event.frame)
      this.emit("webNavigation", "onBeforeNavigate", [navigation(event.url, ids.frameId, ids.parentFrameId)])
    })
    contents.on("did-frame-navigate", (_event, url, _code, _status, isMainFrame, processId, routingId) => {
      const ids = frameIds(isMainFrame, processId, routingId)
      this.emit("webNavigation", "onCommitted", [{
        ...navigation(url, ids.frameId, ids.parentFrameId), transitionType: "link", transitionQualifiers: []
      }])
      if (isMainFrame) updated({ url })
    })
    contents.on("did-navigate-in-page", (_event, url, isMainFrame) => {
      if (!isMainFrame) return
      this.emit("webNavigation", "onCommitted", [{
        ...navigation(url, 0, -1), transitionType: "link", transitionQualifiers: []
      }])
      updated({ url })
    })
    contents.on("dom-ready", () => {
      this.emit("webNavigation", "onDOMContentLoaded", [navigation(contents.getURL(), 0, -1)])
    })
    contents.on("did-frame-finish-load", (_event, isMainFrame, processId, routingId) => {
      const ids = frameIds(isMainFrame, processId, routingId)
      let url = contents.getURL()
      if (!isMainFrame) {
        try {
          url = webFrameMain.fromId(processId, routingId)?.url ?? url
        } catch {
          // Frame already gone; report the document URL instead.
        }
      }
      this.emit("webNavigation", "onCompleted", [navigation(url, ids.frameId, ids.parentFrameId)])
    })
    contents.on("audio-state-changed", (event) => updated({ audible: event.audible }))
    contents.once("destroyed", () => {
      const windowId = this.snapshot(id)?.windowId ?? -1
      this.tabContents.delete(id)
      for (const host of this.hosts.values()) {
        host.action.forgetTab(id)
        for (const entry of host.contexts.all()) {
          if (entry.kind === "content" && entry.tabId === id) host.contexts.remove(entry.id)
        }
      }
      this.emit("tabs", "onRemoved", [id, { windowId, isWindowClosing: false }])
      this.notifyChanged()
    })
  }

  private tabsChanged(): void {
    const active = new Map<number, number>()
    for (const tab of this.options.hooks.tabs()) {
      if (tab.active) active.set(tab.windowId, tab.id)
    }
    let activation = false
    for (const [windowId, tabId] of active) {
      const previous = this.lastActive.get(windowId)
      if (previous !== tabId) {
        activation = true
        this.emit("tabs", "onActivated", [{ tabId, previousTabId: previous, windowId }])
      }
    }
    this.lastActive = active
    if (activation) this.notifyChanged()
  }
}
