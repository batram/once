import { WebContents } from "electron"
import { AddonConversationKey, readConversationKey } from "@once/core"
import { ADDON_CONVERSATION_URL, ELECTRON_IPC } from "@once/platform-electron/bridge"

export function isAddonConversationUrl(url: string): boolean {
  return url.startsWith(ADDON_CONVERSATION_URL)
}

interface Attachment {
  tab: WebContents
  shell: WebContents
  key: AddonConversationKey
  release(): void
}

interface RelayHost {
  /** A new active tab on the URL, for the shell that asked. */
  openTab(shell: WebContents, url: string): Promise<void>
  /** The shell of the window a tab belongs to. */
  shellOf(tab: WebContents): WebContents | undefined
}

/**
 * Passes a tray's conversation between the shell that owns it and a tab that
 * shows its page. The page's URL names the conversation; whenever a tab shows
 * such a page, first time or back through history, it attaches to its window's
 * shell, which answers with the conversation it holds, or with nothing. Main
 * never reads the snapshots or commands; it only keeps each side to its own
 * tab and window, and ends an attachment when the tab leaves the page or
 * closes, or the shell goes away.
 */
export class AddonConversationRelay {
  private readonly attachments = new Map<number, Attachment>()

  constructor(private readonly host: RelayHost) {}

  open(shell: WebContents, url: string): Promise<void> {
    if (!isAddonConversationUrl(url) || !readConversationKey(url)) throw new Error("Not an addon conversation page")
    return this.host.openTab(shell, url)
  }

  /** The page in a tab asks for the conversation its URL names. */
  connect(tab: WebContents): void {
    const key = readConversationKey(tab.getURL())
    if (!key) return
    this.detach(tab.id)
    const shell = this.host.shellOf(tab)
    if (!shell || shell.isDestroyed()) { tab.send(ELECTRON_IPC.addonsConversationState, null, false); return }
    const left = () => { if (this.attachments.get(tab.id) === attachment) this.detach(tab.id) }
    const shellGone = () => {
      if (this.attachments.get(tab.id) !== attachment) return
      this.attachments.delete(tab.id)
      attachment.release()
      this.tell(attachment, null, false)
    }
    const attachment: Attachment = {
      tab, shell, key,
      release: () => {
        tab.removeListener("destroyed", left)
        tab.removeListener("did-navigate", left)
        shell.removeListener("destroyed", shellGone)
      }
    }
    this.attachments.set(tab.id, attachment)
    tab.once("destroyed", left)
    tab.on("did-navigate", left)
    shell.once("destroyed", shellGone)
    shell.send(ELECTRON_IPC.addonsConversationAttach, tab.id, key)
  }

  /** The shell answers, now or after a change: the snapshot, or null for none. */
  push(shell: WebContents, tabId: number, snapshot: unknown): void {
    const attachment = this.attachments.get(tabId)
    if (!attachment || attachment.shell !== shell) return
    this.tell(attachment, snapshot, true)
  }

  command(tab: WebContents, command: unknown): void {
    const attachment = this.attachments.get(tab.id)
    if (!attachment || attachment.tab !== tab || attachment.shell.isDestroyed()) return
    attachment.shell.send(ELECTRON_IPC.addonsConversationCommand, tab.id, command)
  }

  private detach(tabId: number): void {
    const attachment = this.attachments.get(tabId)
    if (!attachment) return
    this.attachments.delete(tabId)
    attachment.release()
    if (!attachment.shell.isDestroyed()) attachment.shell.send(ELECTRON_IPC.addonsConversationDetach, tabId)
  }

  private tell({ tab, key }: Attachment, snapshot: unknown, connected: boolean): void {
    if (tab.isDestroyed()) return
    const shown = readConversationKey(tab.getURL())
    if (shown && shown.addon === key.addon && shown.tray === key.tray && shown.story === key.story) tab.send(ELECTRON_IPC.addonsConversationState, snapshot, connected)
  }
}
