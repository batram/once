import { ContextEntry, ExtensionContexts } from "./ExtensionContexts"
import { INTERNAL_API } from "./protocol"

interface Port {
  a: string
  b: string
}

export interface PortTarget {
  tabId?: number
  frameId?: number
}

/**
 * `runtime.connect` and `tabs.connect`: a port is two contexts joined by an
 * id main hands out. Messages posted on one end are delivered to the other;
 * either end disconnecting, or its context going away, closes both.
 */
export class ExtensionPorts {
  private readonly ports = new Map<number, Port>()
  private nextId = 1

  constructor(private readonly contexts: ExtensionContexts) {
    contexts.onRemoved((entry) => this.closeAll(entry.id))
  }

  /**
   * Finds the other end and tells it about the new port. Firefox semantics:
   * a content script connects to the extension's pages, a page connects to
   * the background page unless it names a tab.
   */
  connect(from: ContextEntry, name: string, target: PortTarget, sender: unknown): number | null {
    const candidates = this.contexts.targets("runtime", "onConnect", (_spec, entry) => {
      if (target.tabId !== undefined) {
        return entry.kind === "content" && entry.tabId === target.tabId &&
          (target.frameId === undefined || entry.frameId === target.frameId)
      }
      return entry.kind !== "content"
    }, from.id)
    const other = candidates.find((candidate) => candidate.entry.kind === "background") ?? candidates[0]
    if (!other) return null
    const id = this.nextId++
    this.ports.set(id, { a: from.id, b: other.entry.id })
    this.contexts.emitTo(other, "runtime", "onConnect", [{ portId: id, name, sender }])
    return id
  }

  post(fromId: string, portId: number, message: unknown): void {
    const other = this.otherEnd(fromId, portId)
    if (!other) return
    other.send({ api: INTERNAL_API.port, event: "message", args: [{ portId, message }] })
  }

  disconnect(fromId: string, portId: number): void {
    const other = this.otherEnd(fromId, portId)
    this.ports.delete(portId)
    other?.send({ api: INTERNAL_API.port, event: "disconnect", args: [{ portId }] })
  }

  private otherEnd(fromId: string, portId: number): ContextEntry | undefined {
    const port = this.ports.get(portId)
    if (!port) return undefined
    const otherId = port.a === fromId ? port.b : port.b === fromId ? port.a : null
    if (otherId === null) return undefined
    const entry = this.contexts.get(otherId)
    return entry && !entry.isDestroyed() ? entry : undefined
  }

  private closeAll(contextId: string): void {
    for (const [id, port] of [...this.ports]) {
      if (port.a === contextId || port.b === contextId) this.disconnect(contextId, id)
    }
  }
}
