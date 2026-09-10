// A tray's conversation on a page of its own, in the main browser surface. The
// shell that owns the addon's sandbox keeps owning the conversation; this page
// shows the snapshots it publishes and sends the reader's input back. Every
// platform mounts the same page and supplies only the transport.
import { AddonConversationCommand, AddonConversationSnapshot } from "@once/core"
import { TrayDisclosures, renderTrayMessages, renderTrayStatus, trayButton } from "./trayMessages"

export interface AddonConversationPort {
  /** The latest state; `connected` false means the shell is gone and nothing can be sent. */
  subscribe(listener: (snapshot: AddonConversationSnapshot | null, connected: boolean) => void): () => void
  send(command: AddonConversationCommand): void
}

/** Mounts the page into `root`; returns the function that unmounts it. */
export function mountAddonConversation(root: HTMLElement, port: AddonConversationPort): () => void {
  const page = new ConversationPage(root, port)
  return () => page.dispose()
}

const DISCONNECTED = "The Once panel that runs this addon is closed. Open it again to continue the conversation."

class ConversationPage {
  private readonly disclosed: TrayDisclosures = new Map()
  private readonly header = document.createElement("header")
  private readonly title = document.createElement("h1")
  private readonly story = document.createElement("a")
  private readonly messages = document.createElement("div")
  private readonly status = document.createElement("div")
  private readonly controls = document.createElement("div")
  private readonly notice = document.createElement("p")
  private readonly form = document.createElement("form")
  private readonly input = document.createElement("textarea")
  private readonly send = trayButton("Ask", () => this.form.requestSubmit())
  private snapshot: AddonConversationSnapshot | null = null
  private connected = true
  private draftTimer: ReturnType<typeof setTimeout> | null = null
  private readonly unsubscribe: () => void

  constructor(private readonly root: HTMLElement, private readonly port: AddonConversationPort) {
    root.classList.add("addon_conversation")
    root.dataset.testid = "addon-conversation"
    this.header.className = "addon_conversation_header"
    this.title.className = "addon_conversation_title"
    this.story.className = "addon_conversation_story"
    this.story.target = "_blank"
    this.story.rel = "noopener noreferrer"
    this.header.append(this.title, this.story)
    this.messages.className = "addon_conversation_messages"
    this.controls.className = "addon_tray_actions addon_tray_controls"
    this.notice.className = "addon_conversation_notice"
    this.notice.setAttribute("role", "status")
    this.notice.hidden = true
    this.form.className = "addon_tray_composer addon_conversation_composer"
    this.input.maxLength = 8000
    this.input.rows = 3
    this.input.addEventListener("input", () => this.draftChanged())
    this.input.addEventListener("keydown", event => {
      if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); this.form.requestSubmit() }
    })
    this.form.addEventListener("submit", event => {
      event.preventDefault()
      const text = this.input.value.trim()
      if (!text || !this.connected || this.snapshot?.busy) return
      this.input.value = ""
      this.port.send({ type: "submit", text })
    })
    this.form.append(this.input, this.send)
    root.replaceChildren(this.header, this.messages, this.status, this.controls, this.notice, this.form)
    this.unsubscribe = port.subscribe((snapshot, connected) => {
      this.connected = connected
      if (snapshot) this.snapshot = snapshot
      this.render()
    })
    this.render()
  }

  dispose(): void {
    this.unsubscribe()
    if (this.draftTimer) clearTimeout(this.draftTimer)
    this.root.replaceChildren()
  }

  /** Typed here, remembered by the tray: sent after a pause, not per keystroke. */
  private draftChanged(): void {
    if (this.draftTimer) clearTimeout(this.draftTimer)
    this.draftTimer = setTimeout(() => {
      this.draftTimer = null
      if (this.connected) this.port.send({ type: "draft", text: this.input.value })
    }, 300)
  }

  private render(): void {
    const snapshot = this.snapshot
    const busy = snapshot?.busy === true
    const usable = this.connected && snapshot !== null
    this.root.dataset.connected = String(this.connected)
    this.title.textContent = snapshot ? `${snapshot.tray.title} · ${snapshot.addon.name}` : "Conversation"
    this.story.textContent = snapshot?.story.title ?? ""
    this.story.href = snapshot?.story.href ?? ""
    this.story.hidden = !snapshot
    document.title = snapshot ? `${snapshot.story.title} · ${snapshot.addon.name}` : "Once conversation"
    this.messages.replaceChildren(...(snapshot ? renderTrayMessages(snapshot.view, this.disclosed) : []))
    this.status.replaceChildren(...(snapshot ? [renderTrayStatus(snapshot.view, busy, snapshot.error)] : []))
    this.controls.replaceChildren()
    if (snapshot && usable) {
      if (busy) this.controls.append(trayButton("Stop", () => this.port.send({ type: "stop" })))
      else {
        for (const action of snapshot.view.actions ?? []) this.controls.append(trayButton(action.label, () => this.port.send({ type: "action", action: action.id })))
        if (snapshot.error) this.controls.append(trayButton("Retry", () => this.port.send({ type: "retry" })))
      }
      this.controls.append(trayButton("Clear conversation", () => this.port.send({ type: "clear" })))
    }
    this.notice.hidden = this.connected
    this.notice.textContent = this.connected ? "" : DISCONNECTED
    this.form.hidden = !snapshot?.view.composer && !!snapshot
    this.input.placeholder = snapshot?.view.composer ?? "Question"
    this.input.setAttribute("aria-label", this.input.placeholder)
    this.input.disabled = !usable || busy
    this.send.disabled = !usable || busy
    // The tray's draft arrives with every snapshot; a composer being typed in keeps its own text.
    if (snapshot && document.activeElement !== this.input && this.draftTimer === null) this.input.value = snapshot.draft
  }
}
