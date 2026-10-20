// Extension pages in their own WebViews: the background page (hidden), the
// browser-action popup, options pages and any other page of the extension a
// tab would have shown. Java creates each WebView on `page.open`, installs
// the page bootstrap at document start and the `onceLitePage` channel for
// the extension's https origin, and relays frames' messages (`page.message`)
// and lifecycle (`page.loaded`, `page.closed`). Each frame of a page is its
// own context, registered on its first message after its URL is checked
// against the owning extension.

import {
  ApiHandler,
  EXTENSION_API_SURFACE,
  ExtensionContextKind,
  applyListenerChange,
  invokeApi,
  settleInvoke
} from "@once/webext-runtime"
import { JavaChannel } from "./javaChannel"
import { pageContextId } from "./liteContexts"
import { LiteExtensionHost } from "./liteHosts"
import {
  BLOB_API,
  PageInit,
  PageLifecycleParams,
  PageMessageParams,
  PageOpenParams,
  PagePostParams,
  PageResizeParams,
  extensionUrlFromPageUrl,
  pageHostOf,
  pageOrigin,
  pageUrlFromExtensionUrl
} from "./protocol"

interface OpenPage {
  pageId: string
  host: LiteExtensionHost
  kind: PageOpenParams["kind"]
  frames: Map<number, { url: string }>
  /** Set for frames inside a tab WebView. */
  tabId?: number
}

/** The source Java installs at document start: the init payload, then the bundle. */
export function pageDocumentStartSource(bundle: string, init: PageInit): string {
  const json = JSON.stringify(init).replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029")
  return `window.__onceLitePageInit = ${json};\n${bundle}`
}

export class LitePages {
  private readonly pages = new Map<string, OpenPage>()
  /**
   * Extension frames inside tabs, by `tab:<tabId>|<extension host>`: one tab
   * can show several extensions' frames, each its own extension's page.
   */
  private readonly tabPages = new Map<string, OpenPage>()
  private nextPageId = 1

  constructor(
    private readonly channel: JavaChannel,
    private readonly bundle: () => string,
    private readonly locale: () => string,
    private readonly handlers: Record<string, ApiHandler>,
    /** The extension a tab frame at an extension origin belongs to, for `tab:<id>` page ids. */
    private readonly hostOf: (extensionHost: string) => LiteExtensionHost | undefined = () => undefined
  ) {
    channel.onEvent("page.message", (params) => this.message(params as PageMessageParams))
    channel.onEvent("page.loaded", (params) => this.loaded(params as PageLifecycleParams))
    channel.onEvent("page.closed", (params) => this.closed(params as PageLifecycleParams))
  }

  /** The document-start source for one of the host's pages shown inside a tab (kind `page`). */
  tabPageSource(host: LiteExtensionHost): string {
    return pageDocumentStartSource(this.bundle(), {
      id: host.extension.id, host: host.extension.host, kind: "page",
      manifest: host.extension.rawManifest, messages: host.extension.messages, uiLanguage: this.locale()
    })
  }

  /** Opens a page of the extension; `url` may be in either form. */
  async open(host: LiteExtensionHost, kind: PageOpenParams["kind"], url: string): Promise<string> {
    const pageId = `${kind}-${host.extension.host.slice(0, 8)}-${this.nextPageId++}`
    const init: PageInit = {
      id: host.extension.id,
      host: host.extension.host,
      kind,
      manifest: host.extension.rawManifest,
      messages: host.extension.messages,
      uiLanguage: this.locale()
    }
    this.pages.set(pageId, { pageId, host, kind, frames: new Map() })
    try {
      await this.channel.request("page.open", {
        pageId,
        kind,
        host: host.extension.host,
        url: pageUrlFromExtensionUrl(url),
        origin: pageOrigin(host.extension.host),
        documentStartSource: pageDocumentStartSource(this.bundle(), init)
      } satisfies PageOpenParams)
    } catch (error) {
      this.pages.delete(pageId)
      throw error
    }
    return pageId
  }

  async close(pageId: string): Promise<void> {
    if (!this.pages.has(pageId)) return
    await this.channel.request("page.close", { pageId })
    this.closed({ pageId })
  }

  /** Every open page of a host, so unloading closes them. */
  pagesOf(host: LiteExtensionHost): string[] {
    return [...this.pages.values()].filter((page) => page.host === host).map((page) => page.pageId)
  }

  openPopup(host: LiteExtensionHost): string | undefined {
    return [...this.pages.values()].find((page) => page.host === host && page.kind === "popup")?.pageId
  }

  pageIdOfTarget(pageId: string): OpenPage | undefined {
    return this.pages.get(pageId)
  }

  private frameKind(page: OpenPage, params: PageMessageParams): ExtensionContextKind {
    return params.mainFrame ? page.kind : "page"
  }

  private context(page: OpenPage, params: PageMessageParams) {
    // Java knows a subframe's origin only; the bootstrap says where it really is.
    const reported = typeof params.message.href === "string" && pageHostOf(params.message.href) === pageHostOf(params.url)
      ? params.message.href : params.url
    const extensionUrl = extensionUrlFromPageUrl(reported)
    if (pageHostOf(params.url) !== page.host.extension.host) throw new Error("Untrusted extension page frame")
    const existing = page.frames.get(params.frameId)
    if (existing) {
      existing.url = extensionUrl
      const entry = page.host.contexts.get(pageContextId(page.pageId, params.frameId))
      if (entry) return entry
    }
    const frame = { url: extensionUrl }
    page.frames.set(params.frameId, frame)
    return page.host.contexts.addPageFrame({
      pageId: page.pageId,
      frameId: params.frameId,
      kind: this.frameKind(page, params),
      tabId: page.tabId,
      url: () => frame.url
    })
  }

  /** A frame of a tab WebView showing one of an extension's own pages (uBlock's picker). */
  private tabPage(params: PageMessageParams): OpenPage | undefined {
    const match = /^tab:(\d+)$/.exec(params.pageId)
    const extensionHost = pageHostOf(params.url)
    if (!match || extensionHost === null) return undefined
    const key = `${params.pageId}|${extensionHost}`
    const existing = this.tabPages.get(key)
    if (existing) return existing
    const host = this.hostOf(extensionHost)
    if (!host) return undefined
    const page: OpenPage = { pageId: params.pageId, host, kind: "page", frames: new Map(), tabId: Number(match[1]) }
    this.tabPages.set(key, page)
    return page
  }

  /** The tab closed or its view was replaced: its extension frames are gone. */
  forgetTab(tabId: number): void {
    this.closed({ pageId: `tab:${tabId}` })
  }

  /** An extension unloaded: its frames in tabs go with it. */
  forgetHost(host: LiteExtensionHost): void {
    for (const [key, page] of [...this.tabPages]) if (page.host === host) this.tabPages.delete(key)
  }

  private message(params: PageMessageParams): void {
    const page = params.pageId.startsWith("tab:") ? this.tabPage(params) : this.pages.get(params.pageId)
    if (!page) return
    let entry
    try {
      entry = this.context(page, params)
    } catch (error) {
      this.channel.log("warn", String(error))
      return
    }
    const host = page.host
    const message = params.message
    if (message.type === "invoke") {
      void settleInvoke(() => invokeApi(this.handlers, host, entry, {
        api: message.api, method: message.method, args: message.args
      }, EXTENSION_API_SURFACE)).then((result) => {
        this.channel.request("page.post", {
          pageId: page.pageId, frameId: params.frameId, message: { type: "result", id: message.id, result }
        } satisfies PagePostParams).catch(() => undefined)
      })
    } else if (message.type === "listen") {
      try {
        applyListenerChange(host, entry, message.change, EXTENSION_API_SURFACE)
      } catch (error) {
        this.channel.log("error", `[${host.extension.name}] listener refused: ${String(error)}`)
      }
    } else if (message.type === "reply") {
      host.contexts.handleReply(entry.id, { token: message.token, result: message.result })
    } else if (message.type === "popup-size" && page.kind === "popup" && params.mainFrame) {
      if (Number.isFinite(message.width) && Number.isFinite(message.height)) {
        this.channel.request("page.resize", {
          pageId: page.pageId, width: message.width, height: message.height
        } satisfies PageResizeParams).catch(() => undefined)
      }
    }
  }

  /**
   * One of the extension's `blob:` URLs as text, read by its background page
   * (`__liteBlob` event, answered like any event with a token).
   */
  async readBlob(host: LiteExtensionHost, blobUrl: string): Promise<string | null> {
    const background = this.pagesOf(host).map((pageId) => this.pages.get(pageId)).find((page) => page?.kind === "background")
    const entry = background && host.contexts.get(pageContextId(background.pageId, 0))
    if (!entry) return null
    const [text] = await host.contexts.request({ entry, listenerIds: [] }, BLOB_API, "read", [{ url: blobUrl }], 10_000)
    return typeof text === "string" ? text : null
  }

  private loaded(params: PageLifecycleParams): void {
    const page = this.pages.get(params.pageId)
    if (!page) return
    if (page.kind === "background") page.host.backgroundLoaded()
  }

  private closed(params: PageLifecycleParams): void {
    if (params.pageId.startsWith("tab:")) {
      for (const [key, page] of [...this.tabPages]) {
        if (page.pageId !== params.pageId) continue
        this.tabPages.delete(key)
        for (const frameId of page.frames.keys()) page.host.contexts.remove(pageContextId(page.pageId, frameId))
      }
      return
    }
    const page = this.pages.get(params.pageId)
    if (!page) return
    this.pages.delete(params.pageId)
    for (const frameId of page.frames.keys()) page.host.contexts.remove(pageContextId(page.pageId, frameId))
  }
}
