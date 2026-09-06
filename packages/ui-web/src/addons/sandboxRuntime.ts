// Runs inside the add-on sandbox frame, and nowhere else. It receives the
// add-on's code from the parent, runs it as a module, hands it the `once`
// object, and relays requests and operations. Nothing here may import from
// the rest of the UI: this file is bundled alone into the sandbox page.

import type {
  HostToSandbox, SandboxOperation, SandboxToHost, StoryView,
  OnceAddonApi as OnceApi, AddonCollectorHandlers as CollectorHandlers, AddonFetchResult as FetchResult,
  AddonTrayContext, AddonResponse, AddonStoryContent
} from "@once/core"

type InvokeHandler = (action: string, story: StoryView) => unknown
type BadgesHandler = (contribution: string, stories: readonly StoryView[]) => unknown
type SettingsListener = (settings: Readonly<Record<string, unknown>>) => void

/** Everything the add-on registered, and the request currently being answered. */
class RuntimeState {
  invoke: InvokeHandler | null = null
  badges: BadgesHandler | null = null
  panel: ((action: string) => unknown) | null = null
  tray: Parameters<OnceApi["onTray"]>[0] | null = null
  readonly controllers = new Map<number, AbortController>()
  settings: Record<string, unknown> = {}
  readonly collectors = new Map<string, CollectorHandlers>()
  readonly settingsListeners: SettingsListener[] = []
  readonly awaitingOps = new Map<number, { requestId?: number; resolve(value: unknown): void; reject(error: Error): void }>()
  readonly storyRequests = new WeakMap<StoryView, number>()
  nextOp = 1
}

function describe(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error)
}

function askOperation(state: RuntimeState, post: (message: SandboxToHost) => void, operation: SandboxOperation, requestId?: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const opId = state.nextOp++
    state.awaitingOps.set(opId, { resolve, reject, requestId })
    post({ type: "op", opId, requestId, op: operation })
  })
}

function createApi(state: RuntimeState, post: (message: SandboxToHost) => void): OnceApi {
  const op = (story: StoryView, operation: SandboxOperation): void =>
    post({ type: "op", requestId: state.storyRequests.get(story), op: operation })
  const ask = (operation: SandboxOperation): Promise<unknown> => askOperation(state, post, operation)
  return {
    get settings() {
      return state.settings
    },
    collectors: {
      register: (id, handlers) => {
        if (typeof handlers?.parse !== "function") throw new Error(`Collector ${id} needs a parse function`)
        state.collectors.set(id, handlers)
      }
    },
    storage: {
      get: (key) => ask({ name: "storage.get", href: "", key }),
      set: async (key, value) => { await ask({ name: "storage.set", href: "", key, value }) }
    },
    fetch: (url) => ask({ name: "fetch", href: "", url }) as Promise<FetchResult>,
    request: (connection, request, context) => context ? context.request(connection, request) : ask({ name: "request", href: "", connection, request }) as Promise<AddonResponse>,
    getStoryContent: story => askOperation(state, post, { name: "story.content", href: story.href }, state.storyRequests.get(story)) as Promise<AddonStoryContent>,
    onTray: handler => { state.tray = handler },
    onInvoke: (handler) => { state.invoke = handler },
    onPanel: (handler) => { state.panel = handler },
    onBadges: (handler) => { state.badges = handler },
    onSettings: (handler) => { state.settingsListeners.push(handler) },
    openUrl: (story, url, target) => op(story, { name: "openUrl", href: story.href, url, target }),
    copyText: (story, text) => op(story, { name: "copyText", href: story.href, text }),
    search: (story, query) => op(story, { name: "search", href: story.href, query }),
    notify: (story, text) => op(story, { name: "notify", href: story.href, text }),
    setReadState: (story, readState) => op(story, { name: "setReadState", href: story.href, state: readState }),
    toggleBookmark: (story) => op(story, { name: "toggleBookmark", href: story.href }),
    addTag: (story, tag) => op(story, { name: "addTag", href: story.href, tag }),
    updateBadge: (story, contribution, text) => op(story, { name: "updateBadge", href: story.href, contribution, text })
  }
}

/** Runs the add-on's default export against the API, once, and reports ready. */
async function load(
  message: Extract<HostToSandbox, { type: "load" }>,
  state: RuntimeState,
  api: OnceApi,
  post: (message: SandboxToHost) => void
): Promise<void> {
  state.settings = { ...message.settings }
  const url = URL.createObjectURL(new Blob([message.code], { type: "text/javascript" }))
  try {
    const module = (await import(/* webpackIgnore: true */ url)) as { default?: unknown }
    if (typeof module.default !== "function") {
      throw new Error("The add-on script must export a default function(once)")
    }
    await module.default(api)
    post({ type: "ready", protocol: message.protocol })
  } catch (error) {
    post({ type: "error", message: `Add-on failed to start: ${describe(error)}` })
  } finally {
    URL.revokeObjectURL(url)
  }
}

/** The handler a request goes to, or a throw the host will see as the request's error. */
function work(message: HostToSandbox, state: RuntimeState, post: (message: SandboxToHost) => void): () => unknown {
  switch (message.type) {
    case "tray": return () => {
      if (!state.tray) throw new Error("The addon registered no tray handler")
      const controller = new AbortController()
      state.controllers.set(message.requestId, controller)
      const ask = (operation: SandboxOperation) => {
        controller.signal.throwIfAborted()
        return askOperation(state, post, operation, message.requestId)
      }
      const context: AddonTrayContext = {
        signal: controller.signal,
        request: (connection, request) => ask({ name: "request", href: "", connection, request }) as Promise<AddonResponse>,
        getStoryContent: () => ask({ name: "story.content", href: message.story.href }) as Promise<AddonStoryContent>
      }
      return state.tray(message.tray, message.event, message.story, context)
    }
    case "invoke":
      return () => {
        if (!state.invoke) throw new Error("The add-on registered no invoke handler")
        return state.invoke(message.action, message.story)
      }
    case "badges":
      return () => {
        if (!state.badges) throw new Error("The add-on registered no badges handler")
        return state.badges(message.contribution, message.stories)
      }
    case "panel.invoke":
      return () => {
        if (!state.panel) throw new Error("The add-on registered no panel handler")
        return state.panel(message.action)
      }
    case "collector.parse":
      return () => {
        const collector = state.collectors.get(message.collector)
        if (!collector) throw new Error(`The add-on registered no collector named ${message.collector}`)
        return collector.parse(message.body, { url: message.url, config: message.config })
      }
    case "collector.search":
      return () => {
        const collector = state.collectors.get(message.collector)
        const search = message.kind === "global" ? collector?.globalSearch : collector?.domainSearch
        if (!search) throw new Error(`Collector ${message.collector} has no ${message.kind} search`)
        return search.call(collector, message.needle)
      }
    default:
      return () => undefined
  }
}

export function startSandboxRuntime(scope: Window): void {
  const parent = scope.parent
  const post = (message: SandboxToHost): void => parent.postMessage(message, "*")
  const state = new RuntimeState()
  const api = createApi(state, post)
  let loaded = false

  const answer = async (requestId: number, run: () => unknown): Promise<void> => {
    try {
      post({ type: "result", requestId, value: await run() })
    } catch (error) {
      post({ type: "error", requestId, message: describe(error) })
    } finally { state.controllers.delete(requestId) }
  }

  scope.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== parent) return
    const message = event.data as HostToSandbox
    if (!message || typeof message !== "object") return
    if (message.type === "load") {
      if (!loaded) {
        loaded = true
        void load(message, state, api, post)
      }
    } else if (message.type === "cancel") {
      state.controllers.get(message.requestId)?.abort()
      for (const [id, pending] of state.awaitingOps) {
        if (pending.requestId !== message.requestId) continue
        pending.reject(new Error("Request cancelled"))
        state.awaitingOps.delete(id)
      }
    } else if (message.type === "settings") {
      state.settings = { ...message.settings }
      for (const listener of state.settingsListeners) listener(state.settings)
    } else if (message.type === "opResult") {
      const waiting = state.awaitingOps.get(message.opId)
      if (!waiting) return
      state.awaitingOps.delete(message.opId)
      if (message.ok) waiting.resolve(message.value)
      else waiting.reject(new Error(message.error ?? "refused"))
    } else {
      if (message.type === "invoke" || message.type === "tray") state.storyRequests.set(message.story, message.requestId)
      if (message.type === "badges") {
        for (const story of message.stories) state.storyRequests.set(story, message.requestId)
      }
      void answer(message.requestId, work(message, state, post))
    }
  })
}
