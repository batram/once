// What content worlds say over the `onceLiteWorld` binding, as Java forwards
// `Runtime.bindingCalled`: a `hello` when the bootstrap starts in a frame
// (which registers the world as one of the extension's contexts), API calls,
// listener changes, replies to events, and scriptlets the page's `<meta>`
// policy refused, which the broker runs in the frame's main world through
// `Runtime.evaluate` in its default context.

import { ApiHandler, applyListenerChange, invokeApi, settleInvoke, surfaceFor } from "@once/webext-runtime"
import { JavaChannel } from "./javaChannel"
import { deliverToWorld, worldContextId } from "./liteContexts"
import { TargetFrames } from "./liteFrames"
import { LiteExtensionHost } from "./liteHosts"
import { CdpCommandParams, TargetKind, WORLD_BINDING, WorldToBrokerMessage, pageHostOf } from "./protocol"

export interface WorldTarget {
  targetId: string
  kind: TargetKind
  tabId: number
  frames: TargetFrames
}

export interface LiteWorldMessagesOptions {
  channel: JavaChannel
  handlers: Record<string, ApiHandler>
  hostOf(extensionHost: string): LiteExtensionHost | undefined
  target(targetId: string): WorldTarget | undefined
}

export class LiteWorldMessages {
  /** Which extension owns each world context, for removal when it goes away. */
  private readonly owners = new Map<string, LiteExtensionHost>()

  constructor(private readonly options: LiteWorldMessagesOptions) {}

  bindingCalled(targetId: string, event: { name: string; payload: string; executionContextId: number }): void {
    if (event.name !== WORLD_BINDING) return
    let message: WorldToBrokerMessage
    try {
      message = JSON.parse(event.payload)
    } catch {
      this.options.channel.log("warn", "Unparseable world message")
      return
    }
    const target = this.options.target(targetId)
    const host = typeof message?.host === "string" ? this.options.hostOf(message.host) : undefined
    if (!target || !host) return
    const contextId = event.executionContextId
    if (message.type === "hello") {
      this.hello(target, host, contextId, message)
      return
    }
    const entry = host.contexts.get(worldContextId(targetId, contextId))
    if (!entry) return
    if (message.type === "invoke") {
      const { id, api, method, args } = message
      void settleInvoke(() => invokeApi(this.options.handlers, host, entry, { api, method, args }, surfaceFor(entry)))
        .then((result) => deliverToWorld(this.options.channel, targetId, contextId, { type: "result", id, result }))
    } else if (message.type === "listen") {
      try {
        applyListenerChange(host, entry, message.change, surfaceFor(entry))
      } catch (error) {
        this.options.channel.log("error", `[${host.extension.name}] content listener refused: ${String(error)}`)
      }
    } else if (message.type === "reply") {
      host.contexts.handleReply(entry.id, { token: message.token, result: message.result })
    } else if (message.type === "main-eval") {
      this.mainEval(target, contextId, message.code)
    }
  }

  private hello(
    target: WorldTarget,
    host: LiteExtensionHost,
    contextId: number,
    message: Extract<WorldToBrokerMessage, { type: "hello" }>
  ): void {
    const world = target.frames.world(contextId)
    const frameId = world ? target.frames.webextFrameId(world.frameId) : 0
    const url = message.url
    // A frame showing one of the extension's own web-accessible pages is the
    // extension's page inside the tab, not a content-script host.
    const ownPage = pageHostOf(url) === host.extension.host
    const entry = host.contexts.addWorld({
      targetId: target.targetId,
      contextId,
      tabId: target.tabId,
      frameId,
      kind: ownPage ? "page" : "content",
      url: () => url,
      creatorUrl: () => message.creatorUrl
    })
    this.owners.set(entry.id, host)
  }

  contextGone(targetId: string, contextId: number): void {
    const id = worldContextId(targetId, contextId)
    const host = this.owners.get(id)
    this.owners.delete(id)
    host?.contexts.remove(id)
  }

  /** Runs code in the main world of the frame the world context belongs to. */
  private mainEval(target: WorldTarget, worldContextId_: number, code: string): void {
    const world = target.frames.world(worldContextId_)
    const mainContextId = world ? target.frames.mainContextId(world.frameId) : null
    const params: Record<string, unknown> = { expression: code, returnByValue: true, awaitPromise: false }
    if (mainContextId !== null) params.contextId = mainContextId
    this.options.channel.request("cdp.command", {
      targetId: target.targetId, method: "Runtime.evaluate", params
    } satisfies CdpCommandParams).catch((error) => {
      this.options.channel.log("warn", `Main-world evaluation failed: ${String(error)}`)
    })
  }
}
