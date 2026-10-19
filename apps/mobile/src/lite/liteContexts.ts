// Extension contexts over Lite's two transports. A page context is one
// frame of an extension-page WebView: messages travel over the frame's
// `onceLitePage` WebMessage channel, which Java relays (`page.post`). A
// world context is one `once-ext:<host>` execution context in a tab target:
// messages are delivered by having Java evaluate `__onceLiteDeliver(json)`
// in that context (`cdp.command Runtime.evaluate`), and the world's calls
// arrive as `Runtime.bindingCalled`.

import { ContextEntry, ExtensionContextKind, ExtensionContexts } from "@once/webext-runtime"
import { JavaChannel } from "./javaChannel"
import { BrokerToWorldMessage, CdpCommandParams, PagePostParams, WORLD_DELIVER } from "./protocol"

export function pageContextId(pageId: string, frameId: number): string {
  return `page:${pageId}:${frameId}`
}

export function worldContextId(targetId: string, contextId: number): string {
  return `world:${targetId}:${contextId}`
}

export interface PageFrameContextOptions {
  pageId: string
  frameId: number
  kind: ExtensionContextKind
  /** For a frame inside a tab WebView: the tab; extension page WebViews have none. */
  tabId?: number
  url(): string
}

export class LiteExtensionContexts extends ExtensionContexts {
  constructor(private readonly channel: JavaChannel) {
    super()
  }

  /** One frame of an extension page WebView; the main frame is frame 0. */
  addPageFrame(options: PageFrameContextOptions): ContextEntry {
    let destroyed = false
    const entry = this.addEntry({
      id: pageContextId(options.pageId, options.frameId),
      kind: options.kind,
      tabId: options.tabId ?? -1,
      frameId: options.frameId,
      listeners: new Map(),
      url: () => (destroyed ? "" : options.url()),
      isDestroyed: () => destroyed,
      send: (message) => {
        if (destroyed) return
        this.channel.request("page.post", {
          pageId: options.pageId, frameId: options.frameId, message: { type: "event", message }
        } satisfies PagePostParams).catch(() => undefined)
      }
    })
    this.onRemoved((removed) => {
      if (removed === entry) destroyed = true
    })
    return entry
  }

  /**
   * This extension's world in one frame of a tab, or, as a `page`, a frame
   * of the tab showing one of the extension's own web-accessible pages.
   */
  addWorld(options: {
    targetId: string
    contextId: number
    tabId: number
    frameId: number
    kind?: ExtensionContextKind
    url(): string
    creatorUrl(): string
  }): ContextEntry {
    let destroyed = false
    const entry = this.addEntry({
      id: worldContextId(options.targetId, options.contextId),
      kind: options.kind ?? "content",
      tabId: options.tabId,
      frameId: options.frameId,
      listeners: new Map(),
      url: () => (destroyed ? "" : options.url()),
      creatorUrl: () => (destroyed ? "" : options.creatorUrl()),
      isDestroyed: () => destroyed,
      send: (message) => {
        if (destroyed) return
        deliverToWorld(this.channel, options.targetId, options.contextId, { type: "event", message })
      }
    })
    this.onRemoved((removed) => {
      if (removed === entry) destroyed = true
    })
    return entry
  }
}

/** Evaluates `__onceLiteDeliver(json)` in the world's context through Java. */
export function deliverToWorld(
  channel: JavaChannel,
  targetId: string,
  contextId: number,
  message: BrokerToWorldMessage
): void {
  channel.request("cdp.command", {
    targetId,
    method: "Runtime.evaluate",
    params: {
      expression: `${WORLD_DELIVER}(${JSON.stringify(JSON.stringify(message))})`,
      contextId,
      returnByValue: true,
      awaitPromise: false
    }
  } satisfies CdpCommandParams).catch((error) => {
    channel.log("warn", `Delivery to world ${targetId}/${contextId} failed: ${String(error)}`)
  })
}

