import { WebContents } from "electron"
import { ELECTRON_IPC } from "@once/platform-electron/bridge"

/** Where the page of a conversation lives; `token` names it in every message. */
export const ADDON_CONVERSATION_ORIGIN = "once-addon://conversation/"
const TOKEN = /^[a-zA-Z0-9-]{8,64}$/

export function addonConversationUrl(token: string): string {
  if (!TOKEN.test(token)) throw new Error("Invalid conversation token")
  return `${ADDON_CONVERSATION_ORIGIN}index.html?token=${encodeURIComponent(token)}`
}

export function isAddonConversationUrl(url: string): boolean {
  return url.startsWith(ADDON_CONVERSATION_ORIGIN)
}

interface Conversation {
  shell: WebContents
  snapshot: unknown
  tab: WebContents | null
}

/**
 * Passes a tray's conversation between the shell that owns it and the tab that
 * shows it. Main never reads the snapshots or commands it carries; it only
 * checks that each side is who the token says, and tells the shell when the
 * tab is gone and the tab when the shell is.
 */
export class AddonConversationRelay {
  private readonly conversations = new Map<string, Conversation>()

  constructor(private readonly openTab: (shell: WebContents, url: string) => Promise<WebContents>) {}

  /** The shell opens a tab for the conversation; the page connects under the same token. */
  async open(shell: WebContents, token: string, snapshot: unknown): Promise<void> {
    const url = addonConversationUrl(token)
    if (this.conversations.has(token)) throw new Error("This conversation is already open")
    const conversation: Conversation = { shell, snapshot, tab: null }
    this.conversations.set(token, conversation)
    const closed = () => this.close(token)
    shell.once("destroyed", closed)
    try {
      const tab = await this.openTab(shell, url)
      conversation.tab = tab
      tab.once("destroyed", closed)
      tab.on("did-navigate", (_event, next) => { if (!isAddonConversationUrl(next)) closed() })
    } catch (error) {
      this.conversations.delete(token)
      throw error
    }
  }

  push(shell: WebContents, token: string, snapshot: unknown): void {
    const conversation = this.conversations.get(token)
    if (!conversation || conversation.shell !== shell) return
    conversation.snapshot = snapshot
    this.tell(conversation, snapshot, true)
  }

  /** The page in the tab asks for the conversation; only the tab opened for it may. */
  connect(tab: WebContents, token: string): unknown {
    const conversation = this.conversations.get(token)
    if (!conversation || conversation.tab !== tab) return null
    return conversation.snapshot
  }

  command(tab: WebContents, token: string, command: unknown): void {
    const conversation = this.conversations.get(token)
    if (!conversation || conversation.tab !== tab || conversation.shell.isDestroyed()) return
    conversation.shell.send(ELECTRON_IPC.addonsConversationCommand, token, command)
  }

  private close(token: string): void {
    const conversation = this.conversations.get(token)
    if (!conversation) return
    this.conversations.delete(token)
    if (!conversation.shell.isDestroyed()) conversation.shell.send(ELECTRON_IPC.addonsConversationClosed, token)
    this.tell(conversation, conversation.snapshot, false)
  }

  private tell(conversation: Conversation, snapshot: unknown, connected: boolean): void {
    const { tab } = conversation
    if (tab && !tab.isDestroyed() && isAddonConversationUrl(tab.getURL())) tab.send(ELECTRON_IPC.addonsConversationState, snapshot, connected)
  }
}
