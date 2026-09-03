// Runs inside the add-on sandbox frame, and nowhere else. It receives the
// add-on's code from the parent, runs it as a module, hands it the `once`
// object, and relays requests and operations. Nothing here may import from
// the rest of the UI: this file is bundled alone into the sandbox page.

import type { HostToSandbox, SandboxOperation, SandboxToHost, StoryView } from "@once/core"

type InvokeHandler = (action: string, story: StoryView) => unknown
type BadgesHandler = (contribution: string, stories: readonly StoryView[]) => unknown

interface OnceApi {
  readonly settings: Readonly<Record<string, unknown>>
  onInvoke(handler: InvokeHandler): void
  onBadges(handler: BadgesHandler): void
  onSettings(handler: (settings: Readonly<Record<string, unknown>>) => void): void
  openUrl(story: StoryView, url: string, target?: "_self" | "blank" | "middle"): void
  copyText(story: StoryView, text: string): void
  search(story: StoryView, query: string): void
  notify(story: StoryView, text: string): void
  setReadState(story: StoryView, state: "unread" | "read" | "skipped"): void
  toggleBookmark(story: StoryView): void
  addTag(story: StoryView, tag: string): void
  updateBadge(story: StoryView, contribution: string, text: string): void
}

export function startSandboxRuntime(scope: Window): void {
  const parent = scope.parent
  const post = (message: SandboxToHost): void => parent.postMessage(message, "*")
  let invoke: InvokeHandler | null = null
  let badges: BadgesHandler | null = null
  let settings: Record<string, unknown> = {}
  const settingsListeners: ((settings: Readonly<Record<string, unknown>>) => void)[] = []
  let currentRequest: number | undefined
  let loaded = false

  const op = (operation: SandboxOperation): void => post({ type: "op", requestId: currentRequest, op: operation })
  const api: OnceApi = {
    get settings() {
      return settings
    },
    onInvoke: (handler) => { invoke = handler },
    onBadges: (handler) => { badges = handler },
    onSettings: (handler) => { settingsListeners.push(handler) },
    openUrl: (story, url, target) => op({ name: "openUrl", href: story.href, url, target }),
    copyText: (story, text) => op({ name: "copyText", href: story.href, text }),
    search: (story, query) => op({ name: "search", href: story.href, query }),
    notify: (story, text) => op({ name: "notify", href: story.href, text }),
    setReadState: (story, state) => op({ name: "setReadState", href: story.href, state }),
    toggleBookmark: (story) => op({ name: "toggleBookmark", href: story.href }),
    addTag: (story, tag) => op({ name: "addTag", href: story.href, tag }),
    updateBadge: (story, contribution, text) => op({ name: "updateBadge", href: story.href, contribution, text })
  }

  const describe = (error: unknown): string =>
    error instanceof Error ? `${error.name}: ${error.message}` : String(error)

  const load = async (message: Extract<HostToSandbox, { type: "load" }>): Promise<void> => {
    if (loaded) return
    loaded = true
    settings = { ...message.settings }
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

  const answer = async (requestId: number, work: () => unknown): Promise<void> => {
    currentRequest = requestId
    try {
      const value = await work()
      post({ type: "result", requestId, value })
    } catch (error) {
      post({ type: "error", requestId, message: describe(error) })
    } finally {
      currentRequest = undefined
    }
  }

  scope.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== parent) return
    const message = event.data as HostToSandbox
    if (!message || typeof message !== "object") return
    switch (message.type) {
      case "load":
        void load(message)
        break
      case "invoke":
        void answer(message.requestId, () => {
          if (!invoke) throw new Error("The add-on registered no invoke handler")
          return invoke(message.action, message.story)
        })
        break
      case "badges":
        void answer(message.requestId, () => {
          if (!badges) throw new Error("The add-on registered no badges handler")
          return badges(message.contribution, message.stories)
        })
        break
      case "settings":
        settings = { ...message.settings }
        for (const listener of settingsListeners) listener(settings)
        break
    }
  })
}
