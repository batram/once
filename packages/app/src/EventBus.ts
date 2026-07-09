import {
  OnceAppEvents,
  OnceEventHandler,
  OnceEventName,
  OnceTransport
} from "./types"

export class LocalEventBus implements OnceTransport {
  private handlers: {
    [T in OnceEventName]?: OnceEventHandler<T>[]
  } = {}

  async request<TResponse = unknown>(): Promise<TResponse> {
    throw new Error("LocalEventBus does not implement remote request")
  }

  publish<T extends OnceEventName>(event: T, payload: OnceAppEvents[T]): void {
    ;(this.handlers[event] || []).forEach((handler) => {
      handler(payload)
    })
  }

  subscribe<T extends OnceEventName>(
    event: T,
    handler: OnceEventHandler<T>
  ): () => void {
    if (!this.handlers[event]) {
      this.handlers[event] = []
    }
    this.handlers[event].push(handler)

    return () => {
      this.handlers[event] = (this.handlers[event] || []).filter(
        (registered) => registered !== handler
      ) as typeof this.handlers[T]
    }
  }
}
