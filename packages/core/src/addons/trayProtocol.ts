/** Host-rendered views: never HTML, and never executable content. */
export interface AddonTray {
  id: string
  title: string
}

export interface AddonCitation { title: string; url: string }
export interface AddonTrayMessage {
  role: "user" | "assistant" | "info"
  text: string
  sources?: readonly AddonCitation[]
}
export interface AddonTrayView {
  messages: readonly AddonTrayMessage[]
  status?: string
  actions?: readonly { id: string; label: string }[]
  composer?: string
}
export interface AddonTrayEvent {
  type: "open" | "action" | "submit" | "clear"
  action?: string
  text?: string
}
export interface AddonStoryContent {
  text: string
  title: string
  sourceUrl: string
  origin: "stored" | "page"
  truncated: boolean
}

export function readTrayView(value: unknown): AddonTrayView {
  if (!value || typeof value !== "object") throw new Error("Invalid tray view")
  const view = value as AddonTrayView
  if (JSON.stringify(value).length > 256_000 || !Array.isArray(view.messages) || view.messages.length > 100) {
    throw new Error("Tray view is too large or has no messages")
  }
  const messages = view.messages.map(message => {
    if (!message || !["user", "assistant", "info"].includes(message.role) || typeof message.text !== "string") {
      throw new Error("Invalid tray message")
    }
    if (message.sources && (!Array.isArray(message.sources) || message.sources.length > 30)) throw new Error("Too many sources")
    const sources = message.sources?.map((source: AddonCitation) => {
      if (!source || typeof source.title !== "string" || source.title.length > 500 || typeof source.url !== "string") {
        throw new Error("Invalid source")
      }
      const url = new URL(source.url)
      if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || source.url.length > 4096) {
        throw new Error("Invalid source URL")
      }
      return { title: source.title, url: url.href }
    })
    return { role: message.role, text: message.text, sources }
  })
  if (view.status !== undefined && (typeof view.status !== "string" || view.status.length > 1000)) throw new Error("Invalid tray status")
  if (view.composer !== undefined && (typeof view.composer !== "string" || view.composer.length > 200)) throw new Error("Invalid composer")
  if (view.actions && (!Array.isArray(view.actions) || view.actions.length > 8)) throw new Error("Too many tray actions")
  const actions = view.actions?.map(action => {
    if (!action || !/^[a-zA-Z0-9_-]{1,40}$/.test(action.id) || typeof action.label !== "string" || action.label.length > 60) {
      throw new Error("Invalid tray action")
    }
    return { id: action.id, label: action.label }
  })
  return { messages, status: view.status, actions, composer: view.composer }
}
