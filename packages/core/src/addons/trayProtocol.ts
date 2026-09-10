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
  /** Renders the message as a disclosure headed by this line, so the reader
      opens the text on demand. Absent means the text is always shown. */
  title?: string
  /** Start a titled message closed. Ignored without `title`. */
  collapsed?: boolean
}
/** Whether a view's `status` reports a failure. Absent means `"info"`. */
export type AddonTrayStatusTone = "info" | "error"

export interface AddonTrayView {
  messages: readonly AddonTrayMessage[]
  status?: string
  /** An addon reports its own failures through `status`, so without this the
      host cannot tell one from a normal progress line and renders both alike. */
  statusTone?: AddonTrayStatusTone
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

/**
 * A tray's conversation as another surface sees it: the story it belongs to,
 * the last view the addon rendered, and whether the host is still working on
 * it. The shell owning the sandbox publishes one after every change; the
 * surface never holds anything the tray does not.
 */
export interface AddonConversationSnapshot {
  addon: { id: string; name: string }
  tray: AddonTray
  story: { href: string; title: string }
  view: AddonTrayView
  busy: boolean
  error: string
  draft: string
}

/**
 * What names a conversation: the addon, its tray, and the story. A page URL
 * carries these, so any surface showing that URL, now or later through
 * history, asks the shell for the same conversation.
 */
export interface AddonConversationKey {
  addon: string
  tray: string
  story: string
}

const CONVERSATION_ID = /^[a-zA-Z0-9_.-]{1,100}$/

export function conversationSearch(key: AddonConversationKey): string {
  return new URLSearchParams({ addon: key.addon, tray: key.tray, story: key.story }).toString()
}

/** The key in a page URL's query, or null when it does not name a conversation. */
export function readConversationKey(url: string): AddonConversationKey | null {
  let params: URLSearchParams
  try { params = new URL(url).searchParams } catch { return null }
  const addon = params.get("addon") ?? ""
  const tray = params.get("tray") ?? ""
  const story = params.get("story") ?? ""
  if (!CONVERSATION_ID.test(addon) || !CONVERSATION_ID.test(tray) || story.length > 4096) return null
  try {
    const href = new URL(story)
    if (!["http:", "https:"].includes(href.protocol)) return null
    return { addon, tray, story: href.href }
  } catch { return null }
}

/** What a surface may ask the owning shell to do with a conversation. */
export type AddonConversationCommand =
  | { type: "submit"; text: string }
  | { type: "action"; action: string }
  | { type: "retry" }
  | { type: "stop" }
  | { type: "clear" }
  | { type: "draft"; text: string }

export function readConversationCommand(value: unknown): AddonConversationCommand {
  const command = value as { type?: unknown; text?: unknown; action?: unknown } | null
  if (!command || typeof command !== "object") throw new Error("Invalid conversation command")
  switch (command.type) {
    case "retry": case "stop": case "clear": return { type: command.type }
    case "submit": case "draft":
      if (typeof command.text !== "string" || command.text.length > 8000) throw new Error("Invalid conversation text")
      return { type: command.type, text: command.text }
    case "action":
      if (typeof command.action !== "string" || !/^[a-zA-Z0-9_-]{1,40}$/.test(command.action)) throw new Error("Invalid conversation action")
      return { type: "action", action: command.action }
    default: throw new Error("Unknown conversation command")
  }
}

export function readConversationSnapshot(value: unknown): AddonConversationSnapshot {
  const snapshot = value as AddonConversationSnapshot | null
  if (!snapshot || typeof snapshot !== "object") throw new Error("Invalid conversation snapshot")
  const text = (candidate: unknown, limit: number): string => {
    if (typeof candidate !== "string" || candidate.length > limit) throw new Error("Invalid conversation snapshot")
    return candidate
  }
  const href = new URL(text(snapshot.story?.href, 4096))
  if (!["http:", "https:"].includes(href.protocol)) throw new Error("Invalid conversation story")
  return {
    addon: { id: text(snapshot.addon?.id, 100), name: text(snapshot.addon?.name, 200) },
    tray: { id: text(snapshot.tray?.id, 100), title: text(snapshot.tray?.title, 200) },
    story: { href: href.href, title: text(snapshot.story?.title, 1000) },
    view: readTrayView(snapshot.view),
    busy: snapshot.busy === true,
    error: text(snapshot.error ?? "", 1000),
    draft: text(snapshot.draft ?? "", 8000)
  }
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
    if (message.title !== undefined && (typeof message.title !== "string" || !message.title.trim() || message.title.length > 120)) throw new Error("Invalid tray message title")
    if (message.collapsed !== undefined && typeof message.collapsed !== "boolean") throw new Error("Invalid tray message collapsed flag")
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
    return { role: message.role, text: message.text, sources, title: message.title, collapsed: message.title ? message.collapsed : undefined }
  })
  if (view.status !== undefined && (typeof view.status !== "string" || view.status.length > 1000)) throw new Error("Invalid tray status")
  if (view.statusTone !== undefined && !["info", "error"].includes(view.statusTone)) throw new Error("Invalid tray status tone")
  if (view.composer !== undefined && (typeof view.composer !== "string" || view.composer.length > 200)) throw new Error("Invalid composer")
  if (view.actions && (!Array.isArray(view.actions) || view.actions.length > 8)) throw new Error("Too many tray actions")
  const actions = view.actions?.map(action => {
    if (!action || !/^[a-zA-Z0-9_-]{1,40}$/.test(action.id) || typeof action.label !== "string" || action.label.length > 60) {
      throw new Error("Invalid tray action")
    }
    return { id: action.id, label: action.label }
  })
  return { messages, status: view.status, statusTone: view.statusTone, actions, composer: view.composer }
}
