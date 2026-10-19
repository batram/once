// The Once Lite broker: the "main process" of the extension runtime, in a
// hidden WebView, driven by Java over `window.onceLite`. It owns the loaded
// extensions (`LiteExtensionHost`), turns the DevTools events Java forwards
// into webRequest stages, frame facts and world contexts, and asks Java for
// everything that touches a WebView, a file or the network.

import {
  ApiHandler,
  DnrEnforcer,
  LoadedExtension,
  OwnPageRequests,
  RuntimePlatform,
  WebRequestRouter,
  createApiHandlers,
  loadExtension,
  parseExtensionUrl
} from "@once/webext-runtime"
import { JavaChannel, MessagePort } from "./javaChannel"
import { FilesInterface, LiteFileReader, readBundle } from "./liteFiles"
import { TargetFrames } from "./liteFrames"
import { LiteExtensionHost } from "./liteHosts"
import { LiteManagement } from "./liteManagement"
import { LitePages } from "./litePages"
import { LiteTabs } from "./liteTabs"
import { LiteWorlds } from "./liteWorlds"
import { LiteWebRequest, RequestTarget, ownPageGrant } from "./liteWebRequest"
import { LiteViolentmonkey } from "./liteViolentmonkey"
import { liteCookieStore } from "./liteCookies"
import { LiteJsonStore } from "./liteStorage"
import { createLiteSettingsCoordinator, readSettings } from "./liteSettings"
import { LiteWorldMessages } from "./liteWorldMessages"
import {
  CdpEventParams,
  CdpFrameTree,
  ExtensionCommandParams,
  StartParams,
  StartResult,
  TargetAttachedParams,
  TargetKind
} from "./protocol"

interface Target {
  targetId: string
  kind: TargetKind
  tabId: number
  pageId?: string
  pageHost?: string
  frames: TargetFrames
}

export class LiteBroker {
  readonly channel: JavaChannel
  private readonly hosts = new Map<string, LiteExtensionHost>()
  private readonly targets = new Map<string, Target>()
  private readonly handlers: Record<string, ApiHandler>
  private readonly ownPages = new OwnPageRequests()
  private readonly dnr = new DnrEnforcer(() => [...this.hosts.values()].map((host) => host.dnr))
  private readonly router: WebRequestRouter
  private readonly webRequest: LiteWebRequest
  private readonly tabs: LiteTabs
  private readonly pages: LitePages
  private readonly worlds: LiteWorlds
  private readonly worldMessages: LiteWorldMessages
  private readonly violentmonkey: LiteViolentmonkey
  private readonly cookies
  private readonly settings
  private management: LiteManagement | null = null
  private start: StartParams | null = null
  private readonly bundles = new Map<string, string>()
  private platform: RuntimePlatform = { locale: () => "en", os: "android", arch: "arm" }

  constructor(port: MessagePort, private readonly files: FilesInterface) {
    this.handlers = createApiHandlers()
    this.channel = new JavaChannel(port)
    this.cookies = liteCookieStore(this.channel)
    this.router = new WebRequestRouter({
      sources: () => [...this.hosts.values()],
      declarative: this.dnr,
      requestFrom: ownPageGrant(() => this.hosts.values(), this.ownPages)
    })
    this.violentmonkey = new LiteViolentmonkey(this.channel)
    this.webRequest = new LiteWebRequest({
      channel: this.channel,
      router: this.router,
      ownPages: this.ownPages,
      hosts: () => this.hosts.values(),
      target: (targetId) => this.requestTarget(targetId),
      token: () => this.start?.token ?? "",
      documentsReleased: () => this.violentmonkey.documentsReleased()
    })
    this.tabs = new LiteTabs({
      channel: this.channel,
      hosts: () => this.hosts.values(),
      openExtensionPage: (url) => this.openExtensionPage(url),
      onTabRemoved: (tabId) => this.tabRemoved(tabId)
    })
    this.pages = new LitePages(
      this.channel, () => this.bundle("lite-page-bootstrap.js"), () => this.platform.locale(), this.handlers,
      (host) => this.hosts.get(host)
    )
    this.worlds = new LiteWorlds(
      this.channel,
      () => this.bundle("lite-world-bootstrap.js"),
      () => this.hosts.values(),
      () => this.platform.locale(),
      () => this.start?.token ?? ""
    )
    this.worldMessages = new LiteWorldMessages({
      channel: this.channel,
      handlers: this.handlers,
      hostOf: (host) => this.hosts.get(host),
      target: (targetId) => this.targets.get(targetId)
    })
    this.settings = createLiteSettingsCoordinator(() => this.hosts.values(), () => this.channel.event("extensions.changed"))
    this.settings.onAdopted((adopted) => this.channel.event("settings.adopted", adopted))
    this.cookies.onChanged((change) => {
      for (const host of this.hosts.values()) {
        if (host.extension.manifest.permissions.has("cookies")) host.contexts.emit("cookies", "onChanged", [change])
      }
    })
    this.registerHandlers()
  }

  hostsLoaded(): LiteExtensionHost[] {
    return [...this.hosts.values()]
  }

  host(extensionHost: string): LiteExtensionHost | undefined {
    return this.hosts.get(extensionHost)
  }

  private bundle(name: string): string {
    let text = this.bundles.get(name)
    if (text === undefined) {
      text = readBundle(this.files, name)
      this.bundles.set(name, text)
    }
    return text
  }

  private registerHandlers(): void {
    this.channel.onRequest("lite.start", (params) => this.handleStart(params as StartParams))
    this.channel.onRequest("extension.command", (params) => this.requireManagement().command(params as ExtensionCommandParams))
    this.channel.onRequest("settings.apply", (params) => this.settings.applySettings(readSettings(params)))
    this.channel.onRequest("extensions.list", () => this.requireManagement().catalog())
    this.channel.onEvent("target.attached", (params) => this.targetAttached(params as TargetAttachedParams))
    this.channel.onEvent("target.detached", (params) => this.targetDetached((params as { targetId: string }).targetId))
    this.channel.onEvent("cdp.event", (params) => this.cdpEvent(params as CdpEventParams))
    this.channel.onEvent("page.console", (params) => {
      const { pageId, level, message } = params as { pageId: string; level: string; message: string }
      if (level === "error" || level === "warning") this.channel.log("error", `[${pageId}] ${message}`)
    })
  }

  private requireManagement(): LiteManagement {
    if (!this.management) throw new Error("The broker has not started")
    return this.management
  }

  private async handleStart(params: StartParams): Promise<StartResult> {
    if (this.start) throw new Error("The broker already started")
    this.start = params
    this.platform = { locale: () => params.locale, os: "android", arch: params.arch }
    this.management = new LiteManagement({
      channel: this.channel,
      files: this.files,
      storageRoot: params.storageRoot,
      locale: () => params.locale,
      runtime: {
        load: (directory, id) => this.load(directory, id),
        unload: (host) => this.unload(host),
        host: (id) => [...this.hosts.values()].find((host) => host.extension.id === id),
        changed: () => this.channel.event("extensions.changed")
      },
      openOptions: (id) => this.openOptions(id),
      openAction: (id) => this.openAction(id)
    })
    await this.management.manager.restore(params.bundled)
    await this.worlds.update()
    return { ready: true, extensions: await this.management.catalog() }
  }

  async load(directory: string, expectedId?: string): Promise<LoadedExtension> {
    const extension = await loadExtension(directory, new LiteFileReader(this.files, directory), this.platform.locale())
    if (expectedId !== undefined && extension.id !== expectedId) {
      throw new Error(`${directory} is ${extension.id}, not the listed ${expectedId}`)
    }
    if (this.hosts.has(extension.host)) await this.unload(extension.host)
    const host = new LiteExtensionHost({
      extension,
      store: new LiteJsonStore(this.channel, `${this.start?.storageRoot ?? ""}/${extension.host}`),
      channel: this.channel,
      cookies: this.cookies,
      platform: this.platform,
      hooks: this.tabs,
      onScriptsChanged: () => this.worlds.schedule(),
      openPage: (owner, kind, url) => this.pages.open(owner, kind, url),
      closePage: (pageId) => this.pages.close(pageId)
    })
    this.hosts.set(extension.host, host)
    host.action.onChanged(() => this.channel.event("extensions.changed"))
    try {
      await this.management?.manager.watch(host)
      await host.start()
    } catch (error) {
      this.hosts.delete(extension.host)
      await host.dispose()
      throw error
    }
    this.violentmonkey.hostChanged(this.hosts.values())
    if (this.start) await this.worlds.update()
    this.channel.event("extensions.changed")
    await this.settings.applyTo(host)
    return extension
  }

  async unload(extensionHost: string): Promise<void> {
    const host = this.hosts.get(extensionHost)
    if (!host) return
    this.hosts.delete(extensionHost)
    this.settings.forget(host)
    for (const pageId of this.pages.pagesOf(host)) await this.pages.close(pageId).catch(() => undefined)
    await host.dispose()
    this.violentmonkey.hostChanged(this.hosts.values())
    this.worlds.schedule()
    this.channel.event("extensions.changed")
  }

  private hostById(id: string): LiteExtensionHost {
    const host = [...this.hosts.values()].find((candidate) => candidate.extension.id === id)
    if (!host) throw new Error("Enable the extension to open its pages")
    return host
  }

  private async openOptions(id: string): Promise<boolean> {
    const host = this.hostById(id)
    const url = host.optionsUrl() ?? host.popupUrl()
    if (!url) return false
    await this.pages.open(host, host.optionsUrl() ? "options" : "popup", url)
    return true
  }

  private async openAction(id: string): Promise<boolean> {
    const host = this.hostById(id)
    const active = this.tabs.tabs().find((tab) => tab.active)
    host.grantActiveTab(active)
    const url = host.popupUrl()
    if (!url) {
      host.contexts.emit("browserAction", "onClicked", [active])
      host.contexts.emit("action", "onClicked", [active])
      return false
    }
    const open = this.pages.openPopup(host)
    if (open) await this.pages.close(open)
    await this.pages.open(host, "popup", url)
    return true
  }

  private async openExtensionPage(url: string): Promise<boolean> {
    const parts = parseExtensionUrl(url)
    const host = parts ? this.hosts.get(parts.host) : undefined
    if (!host) return false
    const options = host.extension.manifest.optionsUi
    const kind = options && parts && parts.path === `/${options.page.replace(/^\/+/, "")}` ? "options" : "page"
    await this.pages.open(host, kind, url)
    return true
  }

  private tabRemoved(tabId: number): void {
    this.dnr.forgetTab(tabId)
    for (const host of this.hosts.values()) host.forgetTab(tabId)
  }

  private requestTarget(targetId: string): RequestTarget | undefined {
    const target = this.targets.get(targetId)
    return target && { kind: target.kind, tabId: target.tabId, pageHost: target.pageHost, frames: target.frames }
  }

  private targetAttached(params: TargetAttachedParams): void {
    const frames = new TargetFrames()
    if (params.frameTree) frames.snapshot(params.frameTree)
    const page = params.pageId ? this.pages.pageIdOfTarget(params.pageId) : undefined
    this.targets.set(params.targetId, {
      targetId: params.targetId,
      kind: params.kind,
      tabId: params.kind === "tab" && typeof params.tabId === "number" ? params.tabId : -1,
      pageId: params.pageId,
      pageHost: page?.host.extension.host,
      frames
    })
    if (params.kind === "tab" && typeof params.tabId === "number") this.tabs.attachTarget(params.tabId, params.targetId)
  }

  private targetDetached(targetId: string): void {
    const target = this.targets.get(targetId)
    if (!target) return
    this.targets.delete(targetId)
    this.webRequest.forgetTarget(targetId)
    for (const world of target.frames.contextsCleared()) this.worldMessages.contextGone(targetId, world.contextId)
  }

  private cdpEvent({ targetId, method, params }: CdpEventParams): void {
    const target = this.targets.get(targetId)
    if (!target) return
    const record = (params ?? {}) as Record<string, unknown>
    switch (method) {
      case "Fetch.requestPaused":
        void this.webRequest.requestPaused(targetId, params as never)
        return
      case "Network.requestWillBeSent":
      case "Network.loadingFinished":
      case "Network.loadingFailed":
        this.webRequest.networkEvent(targetId, method, record)
        return
      case "Runtime.executionContextCreated":
        target.frames.contextCreated(record.context as never)
        return
      case "Runtime.executionContextDestroyed": {
        const world = target.frames.contextDestroyed(Number(record.executionContextId))
        if (world) this.worldMessages.contextGone(targetId, world.contextId)
        return
      }
      case "Runtime.executionContextsCleared":
        for (const world of target.frames.contextsCleared()) this.worldMessages.contextGone(targetId, world.contextId)
        return
      case "Runtime.bindingCalled":
        this.worldMessages.bindingCalled(targetId, record as { name: string; payload: string; executionContextId: number })
        return
      default:
        this.pageEvent(target, method, record)
    }
  }

  private pageEvent(target: Target, method: string, record: Record<string, unknown>): void {
    const frames = target.frames
    if (method === "Page.frameAttached") {
      frames.attached(String(record.frameId), typeof record.parentFrameId === "string" ? record.parentFrameId : null)
    } else if (method === "Page.frameNavigated") {
      const frame = record.frame as { id: string; parentId?: string; url: string }
      frames.navigated(frame.id, frame.parentId ?? null, frame.url)
      if (target.kind === "tab") {
        const facts = frames.facts(frame.id)
        this.tabs.frameNavigated(target.tabId, frame.url, facts.frameId, facts.parentFrameId, false)
        if (facts.frameId === 0) for (const host of this.hosts.values()) host.revokeActiveTab(target.tabId)
      }
    } else if (method === "Page.navigatedWithinDocument") {
      const frameId = String(record.frameId)
      frames.navigated(frameId, undefined, String(record.url))
      if (target.kind === "tab") {
        const facts = frames.facts(frameId)
        this.tabs.frameNavigated(target.tabId, String(record.url), facts.frameId, facts.parentFrameId, true)
      }
    } else if (method === "Page.frameDetached") {
      frames.detached(String(record.frameId))
    } else if (method === "Page.frameTree") {
      frames.snapshot(record as unknown as CdpFrameTree)
    } else if (method === "Page.domContentEventFired" && target.kind === "tab") {
      this.tabs.domContentLoaded(target.tabId)
    } else if (method === "Page.loadEventFired" && target.kind === "tab") {
      this.tabs.loaded(target.tabId)
    }
  }
}
