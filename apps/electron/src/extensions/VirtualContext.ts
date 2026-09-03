import { ContextEntry } from "./ExtensionContexts"
import { ApiHandler, createApiHandlers, senderDescriptor } from "./ExtensionApi"
import { ExtensionHost } from "./ExtensionHost"
import { extensionUrl } from "./ExtensionScheme"
import { ExtensionEvent, INTERNAL_API } from "./protocol"

export interface VirtualPort {
  post(message: unknown): void
  onMessage(listener: (message: unknown) => void): void
  disconnect(): void
}

let nextVirtualId = 1

/**
 * A context of an extension that lives in main rather than in a page: it
 * can send runtime messages and open ports to the background page exactly
 * as one of the extension's own pages would, which is how Once hands
 * settings to uBlock and Violentmonkey through their public message APIs.
 */
export class VirtualContext {
  readonly entry: ContextEntry
  private readonly handlers: Record<string, ApiHandler> = createApiHandlers()
  private readonly portListeners = new Map<number, (message: unknown) => void>()
  private closed = false

  constructor(private readonly host: ExtensionHost) {
    const id = `virtual:${nextVirtualId++}`
    this.entry = host.contexts.addEntry({
      id,
      kind: "page",
      tabId: -1,
      frameId: 0,
      listeners: new Map(),
      // Extensions check the sender's URL against their own origin to
      // decide whether a message is privileged; this one is.
      url: () => extensionUrl(host.extension.host, "/_once/settings"),
      isDestroyed: () => this.closed,
      send: (message) => this.receive(message)
    })
  }

  sendMessage(message: unknown): Promise<unknown> {
    return Promise.resolve(this.call("runtime", "sendMessage", message))
  }

  connectPort(name: string): VirtualPort {
    const portId = this.host.ports.connect(this.entry, name, {}, senderDescriptor(this.host, this.entry))
    if (portId === null) throw new Error(`${this.host.extension.name} has no page listening for ports`)
    return {
      post: (message) => this.host.ports.post(this.entry.id, portId, message),
      onMessage: (listener) => {
        this.portListeners.set(portId, listener)
      },
      disconnect: () => {
        this.portListeners.delete(portId)
        this.host.ports.disconnect(this.entry.id, portId)
      }
    }
  }

  close(): void {
    this.closed = true
    this.host.contexts.remove(this.entry.id)
  }

  private call(api: string, method: string, ...args: unknown[]): unknown {
    const handler = this.handlers[`${api}.${method}`]
    if (!handler) throw new Error(`browser.${api}.${method} is not implemented`)
    return handler({ host: this.host, sender: this.entry }, ...args)
  }

  private receive(message: ExtensionEvent): void {
    if (message.api === INTERNAL_API.port) {
      const [details] = message.args as [{ portId: number; message?: unknown }]
      if (message.event === "message") this.portListeners.get(details.portId)?.(details.message)
      else if (message.event === "disconnect") this.portListeners.delete(details.portId)
      return
    }
    // Nothing here listens to events, but a request must not wait for one.
    if (message.token !== undefined) {
      this.host.contexts.handleReply(this.entry.id, { token: message.token, result: [] })
    }
  }
}
