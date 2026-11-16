// The extension panel's side of a source pick. The background injects the
// picker into one tab and names it; the picker's content script answers with
// a "sourcePicked" runtime message. A runtime message reaches every extension
// page, whoever sent it and whenever, so the panel takes a result only while
// a pick it started is waiting, and only from the top frame of the tab the
// picker was injected into.

export interface PickedMessage {
  onceCommand?: string
  conf?: string | null
  url?: string | null
}

export interface PickedSender {
  id?: string
  frameId?: number
  tab?: { id?: number }
}

export class PendingPick {
  private tabId: number | null = null

  /** A pick this panel started is now running in `tabId`. */
  begin(tabId: number): void {
    this.tabId = tabId
  }

  clear(): void {
    this.tabId = null
  }

  get waiting(): boolean {
    return this.tabId !== null
  }

  /**
   * The picked configuration when `message` finishes the waiting pick, and
   * null for anything else: another command, no waiting pick, another tab or
   * frame, another extension. A cancelled pick (no conf) ends the wait too.
   */
  take(
    message: PickedMessage | undefined,
    sender: PickedSender | undefined,
    extensionId: string | undefined
  ): { conf: string; url: string } | null {
    if (message?.onceCommand !== "sourcePicked") return null
    if (this.tabId === null || sender?.tab?.id !== this.tabId) return null
    if (sender.frameId !== undefined && sender.frameId !== 0) return null
    if (!extensionId || sender.id !== extensionId) return null
    this.tabId = null
    if (typeof message.conf !== "string" || typeof message.url !== "string") {
      return null
    }
    if (!message.conf || !message.url) return null
    return { conf: message.conf, url: message.url }
  }
}
