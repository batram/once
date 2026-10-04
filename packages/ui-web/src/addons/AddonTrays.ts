import {
  AddonConversationCommand, AddonConversationKey, AddonConversationSnapshot, AddonManifest, AddonTrayEvent, AddonTrayView, StoryView,
  addonContributionId, projectStoryView, readTrayView
} from "@once/core"
import type { StoryListItem } from "../story/StoryListItem"
import { registerStoryElement, STORY_TRAYS_CHANGED } from "../story/storyElements"
import { getOnceClient } from "../client"
import { AddonSandbox } from "./AddonSandbox"
import { AddonPage, pageStoryRow, pageStoryView, registerPageTray } from "./pageAddons"
import { TrayDisclosures, renderTrayMessages, renderTrayStatus, trayButton, trayIcon } from "./trayMessages"

/**
 * Where a tray shows: on a row in the list, on the mirror of the open story
 * in #selected_container, or beside a page that has no row at all.
 */
type TrayPlace = "list" | "selected" | "page"

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
  /** Other surfaces showing this conversation; told after every change, and with null when it ends. */
  listeners: Set<(snapshot: AddonConversationSnapshot | null) => void>
}

/**
 * A conversation as handed to another surface: it reads the current state,
 * hears about changes, and sends the reader's input back to the tray that
 * owns the sandbox. The surface never talks to the addon itself.
 */
export interface AddonConversationHandle {
  snapshot(): AddonConversationSnapshot
  /** Null tells the surface the conversation is gone (the addon was reset, disabled or removed). */
  subscribe(listener: (snapshot: AddonConversationSnapshot | null) => void): () => void
  send(command: AddonConversationCommand): void
}

/** A platform's way of continuing a tray somewhere larger, offered as a tray button. */
export interface AddonConversationSurface {
  label: string
  open(handle: AddonConversationHandle): void
  /** The story behind a conversation page's URL, so the shell can treat that page as the story it is about. */
  storyHref?(url: string): string | null
  /** Given at mount: how the surface finds a conversation a page asks for by key; null when the shell has none. */
  connect?(find: (key: AddonConversationKey) => AddonConversationHandle | null): void
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
      const id = addonContributionId(manifest.id, `tray-${tray.id}`)
      this.releases.push(registerStoryElement({ id, slot: "tray", render: row => this.render(row, tray.id) }))
      this.releases.push(registerPageTray(id, href => this.renderPage(href, tray.id)))
    }
  }

  expanded(row: StoryListItem, tray: string): boolean {
    return this.states.get(this.key(row.story.href, tray))?.open.has(this.place(row)) === true
  }

  /** Opens or closes the tray where this row is; the same story elsewhere keeps its own state. */
  toggle(row: StoryListItem, tray: string): void {
    this.togglePlace(this.state(row, tray), row.story.href, tray, this.place(row))
  }

  /**
   * Opens or closes the reading host's tray. Listed pages and their aliases
   * share the story's conversation, with visibility owned by the page host.
   */
  togglePage(page: AddonPage, tray: string): void {
    const href = pageStoryRow(page.href)?.story.href ?? page.href
    this.togglePlace(this.pageState(page, tray), href, tray, "page")
  }

  /**
   * Continues a page's conversation on the platform's larger surface, or on
   * `surface` (the Once panel), starting it when it is new. False when there
   * is no such surface here.
   */
  continuePage(page: AddonPage, tray: string, surface: AddonConversationSurface | undefined = this.surface): boolean {
    if (!surface) return false
    const state = this.pageState(page, tray)
    const href = state.story.href
    if (this.fresh(state)) void this.run(href, tray, { type: "open" })
    surface.open(this.handleOf(href, tray))
    return true
  }

  private togglePlace(state: TrayState, href: string, tray: string, place: TrayPlace): void {
    if (!state.open.delete(place)) state.open.add(place)
    this.refresh(href, tray)
    if (state.open.has(place) && this.fresh(state)) void this.run(href, tray, { type: "open" })
  }

  /** A conversation nothing has happened in yet, so opening it asks the addon to begin. */
  private fresh(state: TrayState): boolean {
    return !state.view.messages.length && !state.error && !state.controller
  }

  /**
   * The conversation a page asks for by story: the one already held, or a
   * fresh one for a story in the list. Null when the story is not around.
   */
  handleFor(tray: string, href: string): AddonConversationHandle | null {
    if (!this.manifest.trays?.some(item => item.id === tray)) return null
    if (this.states.has(this.key(href, tray))) return this.handleOf(href, tray)
    const row = this.rowOf(href)
    return row ? this.handle(row, tray) : null
  }

  private rowOf(href: string): StoryListItem | undefined {
    return Array.from(document.querySelectorAll<StoryListItem>("story-item")).find(item => item.story.href === href)
  }

  /** The conversation of a row's tray for another surface; the tray keeps owning it. */
  handle(row: StoryListItem, tray: string): AddonConversationHandle {
    this.state(row, tray)
    return this.handleOf(row.story.href, tray)
  }

  private handleOf(href: string, tray: string): AddonConversationHandle {
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
    const listeners = Array.from(this.states.values()).flatMap(state => Array.from(state.listeners))
    for (const state of this.states.values()) state.controller?.abort()
    this.states.clear()
    for (const key of keys) {
      const [href, tray] = JSON.parse(key) as [string, string]
      this.refresh(href, tray)
    }
    // A page still showing one of these conversations would otherwise keep a
    // live composer whose input goes nowhere.
    for (const listener of listeners) listener(null)
  }

  dispose(): void {
    this.disposed = true
    this.reset()
    for (const release of this.releases) release()
  }

  private key(href: string, tray: string): string { return JSON.stringify([href, tray]) }

  private place(row: StoryListItem): TrayPlace { return row.closest("#selected_container") ? "selected" : "list" }

  private state(row: StoryListItem, tray: string): TrayState {
    return this.states.get(this.key(row.story.href, tray))
      ?? this.newState(row.story.href, tray, projectStoryView(row.story, row.dataset.redirected_url || row.story.href), row.story.title)
  }

  /** A page's conversation: the story's own when the page is a listed story, else one about the page itself. */
  private pageState(page: AddonPage, tray: string): TrayState {
    const row = pageStoryRow(page.href)
    if (row) return this.state(row, tray)
    const existing = this.states.get(this.key(page.href, tray))
    if (existing) return existing
    const story = pageStoryView(page)
    return this.newState(page.href, tray, story, story.title)
  }

  private newState(href: string, tray: string, story: StoryView, title: string): TrayState {
    const state: TrayState = {
      open: new Set(), story, title,
      draft: "", view: { messages: [] }, error: "", last: { type: "open" }, disclosed: new Map(), listeners: new Set()
    }
    this.states.set(this.key(href, tray), state)
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
      addon: { id: this.manifest.id, name: this.manifest.name, ...(this.manifest.shortName ? { shortName: this.manifest.shortName } : {}) },
      tray: { id: tray, title: this.manifest.trays?.find(item => item.id === tray)?.title ?? tray },
      story: { href, title: state.title },
      view: state.view, busy: !!state.controller, error: state.error, draft: state.draft, canRefresh: Boolean(this.sandbox)
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
      case "refresh":
        if (!state.controller) {
          state.draft = ""
          state.disclosed.clear()
          void this.run(href, tray, { type: "open", refreshSource: true })
        }
        return
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
      if (event.refreshSource) {
        await session.tray(tray, { type: "clear" }, state.story, controller.signal)
        controller.signal.throwIfAborted()
        state.view = { messages: [] }
      }
      // A stopped invocation never recorded what it showed early, so the tray
      // goes back to the last view the addon did return.
      const before = state.view
      let early: AddonTrayView | null = null
      controller.signal.addEventListener("abort", () => { if (early && state.view === early) state.view = before }, { once: true })
      const result = await session.tray(tray, event, state.story, controller.signal, view => {
        if (state.controller !== controller || controller.signal.aborted) return
        state.view = early = view
        this.refresh(href, tray)
      })
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
    return this.renderPlace(row.story.href, tray, this.place(row))
  }

  private renderPage(href: string, tray: string): HTMLElement | null {
    const row = pageStoryRow(href)
    // A reading view can also continue a tray opened from a story row.
    return this.renderPlace(row?.story.href ?? href, tray, "page") ?? (row ? this.render(row, tray) : null)
  }

  private renderPlace(href: string, tray: string, place: TrayPlace): HTMLElement | null {
    const state = this.states.get(this.key(href, tray))
    if (!state?.open.has(place)) return null
    const root = document.createElement("section")
    root.className = "addon_tray"
    root.dataset.testid = "addon-tray"
    root.setAttribute("aria-label", this.manifest.trays?.find(item => item.id === tray)?.title ?? tray)
    for (const type of ["pointerdown", "mousedown", "touchstart", "touchmove", "click", "dblclick", "keydown", "contextmenu"]) root.addEventListener(type, event => event.stopPropagation())
    bindTrayLinks(root)
    const heading = document.createElement("strong")
    heading.className = "addon_tray_title"
    heading.textContent = root.getAttribute("aria-label")
    const header = document.createElement("div")
    header.className = "addon_tray_actions addon_tray_header"
    header.append(heading)
    // A page's own tray is drawn by the platform's reading surface already,
    // so there is nowhere larger to continue it.
    if (this.surface && place !== "page") {
      const surface = this.surface
      const open = trayButton(surface.label, () => surface.open(this.handleOf(href, tray)))
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
    input.addEventListener("keydown", event => {
      // Enter asks; Shift+Enter keeps writing on a new line.
      if (event.key !== "Enter" || event.shiftKey || event.isComposing) return
      event.preventDefault()
      form.requestSubmit()
    })
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

/**
 * Links in a tray are the host's anchors, but they are not left to the
 * browser: the shell is not a page, so a `_blank` navigation from it becomes
 * a bare popup window in Electron rather than a tab. Every platform's client
 * knows where its tabs are, so the click goes there; a middle or modified
 * click asks for a background tab, as it would on a story row.
 */
function bindTrayLinks(root: HTMLElement): void {
  const open = (event: MouseEvent, target: "blank" | "middle") => {
    const link = (event.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null
    if (!link || !root.contains(link)) return
    let client
    try { client = getOnceClient() } catch { return }
    event.preventDefault()
    client.openUrl(link.href, target)
  }
  root.addEventListener("click", event => {
    if (event.button !== 0) return
    open(event, event.ctrlKey || event.metaKey || event.shiftKey ? "middle" : "blank")
  })
  root.addEventListener("auxclick", event => { if (event.button === 1) open(event, "middle") })
  // Chromium opens its own tab for a middle click on mousedown/mouseup as well.
  for (const type of ["mousedown", "mouseup"] as const) root.addEventListener(type, event => {
    if (event.button === 1 && (event.target as Element | null)?.closest?.("a[href]")) event.preventDefault()
  })
}
