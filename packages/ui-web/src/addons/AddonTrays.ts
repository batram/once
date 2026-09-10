import {
  AddonConversationCommand, AddonConversationSnapshot, AddonManifest, AddonTrayEvent, AddonTrayView, StoryView,
  addonContributionId, projectStoryView, readTrayView
} from "@once/core"
import type { StoryListItem } from "../story/StoryListItem"
import { registerStoryElement, STORY_TRAYS_CHANGED } from "../story/storyElements"
import { AddonSandbox } from "./AddonSandbox"
import { TrayDisclosures, renderTrayMessages, renderTrayStatus, trayButton, trayIcon } from "./trayMessages"

/** Where a row lives: the list, or the mirror of the open story in #selected_container. */
type TrayPlace = "list" | "selected"

interface TrayState {
  /** The conversation is one per story; which places show it is the reader's choice per place. */
  open: Set<TrayPlace>
  story: StoryView
  title: string
  draft: string
  view: AddonTrayView
  error: string
  last: AddonTrayEvent
  disclosed: TrayDisclosures
  controller?: AbortController
  /** Other surfaces showing this conversation; told after every change. */
  listeners: Set<(snapshot: AddonConversationSnapshot) => void>
}

/**
 * A conversation as handed to another surface: it reads the current state,
 * hears about changes, and sends the reader's input back to the tray that
 * owns the sandbox. The surface never talks to the addon itself.
 */
export interface AddonConversationHandle {
  snapshot(): AddonConversationSnapshot
  subscribe(listener: (snapshot: AddonConversationSnapshot) => void): () => void
  send(command: AddonConversationCommand): void
}

/** A platform's way of continuing a tray somewhere larger, offered as a tray button. */
export interface AddonConversationSurface {
  label: string
  open(handle: AddonConversationHandle): void
}

/** State belongs to the addon registration, not a replaceable story row. */
export class AddonTrays {
  private readonly states = new Map<string, TrayState>()
  private readonly releases: (() => void)[] = []
  private disposed = false
  constructor(
    private readonly manifest: AddonManifest,
    private readonly sandbox: AddonSandbox | null,
    private readonly surface?: AddonConversationSurface
  ) {
    for (const tray of manifest.trays ?? []) {
      this.releases.push(registerStoryElement({
        id: addonContributionId(manifest.id, `tray-${tray.id}`), slot: "tray",
        render: row => this.render(row, tray.id)
      }))
    }
  }

  expanded(row: StoryListItem, tray: string): boolean {
    return this.states.get(this.key(row.story.href, tray))?.open.has(this.place(row)) === true
  }

  /** Opens or closes the tray where this row is; the same story elsewhere keeps its own state. */
  toggle(row: StoryListItem, tray: string): void {
    const state = this.state(row, tray)
    const place = this.place(row)
    if (!state.open.delete(place)) state.open.add(place)
    this.refresh(row.story.href, tray)
    if (state.open.has(place) && !state.view.messages.length && !state.error && !state.controller) void this.run(row.story.href, tray, { type: "open" })
  }

  /** The conversation of a row's tray for another surface; the tray keeps owning it. */
  handle(row: StoryListItem, tray: string): AddonConversationHandle {
    const href = row.story.href
    this.state(row, tray)
    return {
      snapshot: () => this.snapshot(href, tray),
      subscribe: listener => {
        const state = this.stateFor(href, tray)
        state.listeners.add(listener)
        return () => { state.listeners.delete(listener) }
      },
      send: command => this.command(href, tray, command)
    }
  }

  reset(): void {
    const keys = Array.from(this.states.keys())
    for (const state of this.states.values()) state.controller?.abort()
    this.states.clear()
    for (const key of keys) {
      const [href, tray] = JSON.parse(key) as [string, string]
      this.refresh(href, tray)
    }
  }

  dispose(): void {
    this.disposed = true
    this.reset()
    for (const release of this.releases) release()
  }

  private key(href: string, tray: string): string { return JSON.stringify([href, tray]) }

  private place(row: StoryListItem): TrayPlace { return row.closest("#selected_container") ? "selected" : "list" }

  private state(row: StoryListItem, tray: string): TrayState {
    const key = this.key(row.story.href, tray)
    let state = this.states.get(key)
    if (!state) {
      state = {
        open: new Set(), story: projectStoryView(row.story, row.dataset.redirected_url || row.story.href), title: row.story.title,
        draft: "", view: { messages: [] }, error: "", last: { type: "open" }, disclosed: new Map(), listeners: new Set()
      }
      this.states.set(key, state)
    }
    return state
  }

  private stateFor(href: string, tray: string): TrayState {
    const state = this.states.get(this.key(href, tray))
    if (!state) throw new Error("The tray was reset")
    return state
  }

  private snapshot(href: string, tray: string): AddonConversationSnapshot {
    const state = this.stateFor(href, tray)
    return {
      addon: { id: this.manifest.id, name: this.manifest.name },
      tray: { id: tray, title: this.manifest.trays?.find(item => item.id === tray)?.title ?? tray },
      story: { href, title: state.title },
      view: state.view, busy: !!state.controller, error: state.error, draft: state.draft
    }
  }

  private command(href: string, tray: string, command: AddonConversationCommand): void {
    const state = this.states.get(this.key(href, tray))
    if (!state) return
    switch (command.type) {
      case "submit": {
        const text = command.text.trim()
        if (!text || state.controller) return
        state.draft = ""
        void this.run(href, tray, { type: "submit", text })
        return
      }
      case "action": if (!state.controller) void this.run(href, tray, { type: "action", action: command.action }); return
      case "retry": if (!state.controller) void this.run(href, tray, state.last); return
      case "stop": this.stop(href, tray, state); return
      case "clear": this.clear(href, tray, state); return
      case "draft":
        // Typed elsewhere: remembered for the next redraw, but no redraw now, or
        // the composer the reader is typing into would lose its focus.
        state.draft = command.text
        this.notify(href, tray)
    }
  }

  private stop(href: string, tray: string, state: TrayState): void {
    if (!state.controller) return
    state.controller.abort(); state.controller = undefined; state.error = "Request cancelled"; this.refresh(href, tray)
  }

  private clear(href: string, tray: string, state: TrayState): void {
    state.view = { messages: [] }; state.draft = ""; state.disclosed.clear(); void this.run(href, tray, { type: "clear" })
  }

  private notify(href: string, tray: string): void {
    const state = this.states.get(this.key(href, tray))
    if (!state?.listeners.size) return
    const snapshot = this.snapshot(href, tray)
    for (const listener of state.listeners) listener(snapshot)
  }

  private refresh(href: string, tray: string): void {
    if (this.disposed) return
    for (const row of document.querySelectorAll<StoryListItem>("story-item")) {
      if (row.story.href !== href) continue
      row.querySelector(`[data-story-element="${addonContributionId(this.manifest.id, `tray-${tray}`)}"]`)?.remove()
      const element = this.render(row, tray)
      if (element) {
        element.dataset.storyElement = addonContributionId(this.manifest.id, `tray-${tray}`)
        row.append(element)
      }
      for (const button of row.querySelectorAll<HTMLElement>("[data-addon-tray-button]")) {
        if (button.dataset.addonTrayButton === addonContributionId(this.manifest.id, tray)) button.setAttribute("aria-expanded", String(this.expanded(row, tray)))
      }
    }
    this.notify(href, tray)
    document.dispatchEvent(new CustomEvent(STORY_TRAYS_CHANGED, { detail: href }))
  }

  private async run(href: string, tray: string, event: AddonTrayEvent): Promise<void> {
    const state = this.stateFor(href, tray)
    state.controller?.abort()
    const controller = new AbortController()
    state.controller = controller
    state.last = event
    state.error = ""
    this.refresh(href, tray)
    try {
      if (!this.sandbox) throw new Error("Configure the addon sandbox on this platform first")
      const session = await this.sandbox.ensure()
      controller.signal.throwIfAborted()
      const result = await session.tray(tray, event, state.story, controller.signal)
      if (!controller.signal.aborted) state.view = readTrayView(result)
    } catch (error) {
      if (!controller.signal.aborted) state.error = error instanceof Error ? error.message : String(error)
    } finally {
      if (state.controller === controller) {
        state.controller = undefined
        this.refresh(href, tray)
      }
    }
  }

  private render(row: StoryListItem, tray: string): HTMLElement | null {
    const href = row.story.href
    const state = this.states.get(this.key(href, tray))
    const place = this.place(row)
    if (!state?.open.has(place)) return null
    const root = document.createElement("section")
    root.className = "addon_tray"
    root.dataset.testid = "addon-tray"
    root.setAttribute("aria-label", this.manifest.trays?.find(item => item.id === tray)?.title ?? tray)
    for (const type of ["pointerdown", "mousedown", "touchstart", "touchmove", "click", "dblclick", "keydown", "contextmenu"]) root.addEventListener(type, event => event.stopPropagation())
    const heading = document.createElement("strong")
    heading.className = "addon_tray_title"
    heading.textContent = root.getAttribute("aria-label")
    const header = document.createElement("div")
    header.className = "addon_tray_actions addon_tray_header"
    header.append(heading)
    if (this.surface) {
      const surface = this.surface
      const open = trayButton(surface.label, () => surface.open(this.handle(row, tray)))
      open.dataset.testid = "addon-tray-continue"
      open.prepend(trayIcon("popout", "icon--inline"))
      header.append(open)
    }
    const close = trayButton("Close", () => { state.open.delete(place); this.refresh(href, tray) })
    // The label becomes the accessible name so the glyph can replace the word.
    close.classList.add("button--icon")
    close.setAttribute("aria-label", close.textContent ?? "Close")
    close.replaceChildren(trayIcon("x"))
    header.append(close)
    root.append(header, ...renderTrayMessages(state.view, state.disclosed))
    root.append(renderTrayStatus(state.view, !!state.controller, state.error), this.controls(href, tray, state))
    if (state.view.composer) root.append(this.composer(href, tray, state))
    return root
  }

  private controls(href: string, tray: string, state: TrayState): HTMLElement {
    const controls = document.createElement("div")
    controls.className = "addon_tray_actions addon_tray_controls"
    if (state.controller) controls.append(trayButton("Stop", () => this.stop(href, tray, state)))
    else {
      for (const action of state.view.actions ?? []) controls.append(trayButton(action.label, () => { void this.run(href, tray, { type: "action", action: action.id }) }))
      if (state.error) controls.append(trayButton("Retry", () => { void this.run(href, tray, state.last) }))
    }
    controls.append(trayButton("Clear conversation", () => this.clear(href, tray, state)))
    return controls
  }

  private composer(href: string, tray: string, state: TrayState): HTMLElement {
    const form = document.createElement("form")
    form.className = "addon_tray_composer"
    const input = document.createElement("textarea")
    input.placeholder = state.view.composer ?? "Question"
    input.setAttribute("aria-label", input.placeholder)
    input.maxLength = 8000
    input.rows = 2
    input.value = state.draft
    input.disabled = !!state.controller
    input.addEventListener("input", () => { state.draft = input.value; this.notify(href, tray) })
    const send = trayButton("Ask", () => form.requestSubmit())
    send.disabled = !!state.controller
    form.addEventListener("submit", event => {
      event.preventDefault()
      this.command(href, tray, { type: "submit", text: state.draft })
    })
    form.append(input, send)
    return form
  }
}
