import { AddonManifest, AddonTrayEvent, AddonTrayView, StoryView, addonContributionId, projectStoryView, readTrayView } from "@once/core"
import type { StoryListItem } from "../story/StoryListItem"
import { registerStoryElement } from "../story/storyElements"
import { AddonSandbox } from "./AddonSandbox"

interface TrayState {
  open: boolean
  draft: string
  view: AddonTrayView
  error: string
  last: AddonTrayEvent
  controller?: AbortController
}

/** State belongs to the addon registration, not a replaceable story row. */
export class AddonTrays {
  private readonly states = new Map<string, TrayState>()
  private readonly releases: (() => void)[] = []
  private disposed = false
  constructor(private readonly manifest: AddonManifest, private readonly sandbox: AddonSandbox | null) {
    for (const tray of manifest.trays ?? []) {
      this.releases.push(registerStoryElement({
        id: addonContributionId(manifest.id, `tray-${tray.id}`), slot: "tray",
        render: row => this.render(row, tray.id)
      }))
    }
  }

  expanded(href: string, tray: string): boolean { return this.states.get(this.key(href, tray))?.open === true }

  toggle(row: StoryListItem, tray: string): void {
    const state = this.state(row.story.href, tray)
    state.open = !state.open
    this.refresh(row.story.href, tray)
    if (state.open && !state.view.messages.length && !state.error && !state.controller) void this.run(row, tray, { type: "open" })
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

  private state(href: string, tray: string): TrayState {
    const key = this.key(href, tray)
    let state = this.states.get(key)
    if (!state) {
      state = { open: false, draft: "", view: { messages: [] }, error: "", last: { type: "open" } }
      this.states.set(key, state)
    }
    return state
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
        if (button.dataset.addonTrayButton === addonContributionId(this.manifest.id, tray)) button.setAttribute("aria-expanded", String(this.expanded(href, tray)))
      }
    }
  }

  private async run(row: StoryListItem, tray: string, event: AddonTrayEvent): Promise<void> {
    const state = this.state(row.story.href, tray)
    state.controller?.abort()
    const controller = new AbortController()
    state.controller = controller
    state.last = event
    state.error = ""
    this.refresh(row.story.href, tray)
    try {
      if (!this.sandbox) throw new Error("Configure the addon sandbox on this platform first")
      const session = await this.sandbox.ensure()
      controller.signal.throwIfAborted()
      const story: StoryView = projectStoryView(row.story, row.dataset.redirected_url || row.story.href)
      const result = await session.tray(tray, event, story, controller.signal)
      if (!controller.signal.aborted) state.view = readTrayView(result)
    } catch (error) {
      if (!controller.signal.aborted) state.error = error instanceof Error ? error.message : String(error)
    } finally {
      if (state.controller === controller) {
        state.controller = undefined
        this.refresh(row.story.href, tray)
      }
    }
  }

  private render(row: StoryListItem, tray: string): HTMLElement | null {
    const state = this.states.get(this.key(row.story.href, tray))
    if (!state?.open) return null
    const root = document.createElement("section")
    root.className = "addon_tray"
    root.dataset.testid = "addon-tray"
    root.setAttribute("aria-label", this.manifest.trays?.find(item => item.id === tray)?.title ?? tray)
    for (const type of ["pointerdown", "mousedown", "touchstart", "touchmove", "click", "dblclick", "keydown", "contextmenu"]) root.addEventListener(type, event => event.stopPropagation())
    const heading = document.createElement("strong")
    heading.textContent = root.getAttribute("aria-label")
    const close = this.button("Close", () => { state.open = false; this.refresh(row.story.href, tray) })
    const header = document.createElement("div")
    header.className = "addon_tray_actions"
    header.append(heading, close)
    root.append(header)
    for (const message of state.view.messages) {
      const block = document.createElement("div")
      block.className = `addon_tray_message addon_tray_${message.role}`
      block.textContent = message.text
      root.append(block)
      for (const source of message.sources ?? []) {
        const link = document.createElement("a")
        link.textContent = source.title || source.url
        link.href = source.url
        link.target = "_blank"
        link.rel = "noopener noreferrer"
        link.className = "addon_tray_source"
        root.append(link)
      }
    }
    const status = document.createElement("p")
    status.setAttribute("role", "status")
    status.textContent = state.controller ? "Working…" : state.error || state.view.status || ""
    root.append(status, this.controls(row, tray, state))
    if (state.view.composer) root.append(this.composer(row, tray, state))
    return root
  }

  private controls(row: StoryListItem, tray: string, state: TrayState): HTMLElement {
    const controls = document.createElement("div")
    controls.className = "addon_tray_actions"
    if (state.controller) controls.append(this.button("Stop", () => {
      state.controller?.abort(); state.controller = undefined; state.error = "Request cancelled"; this.refresh(row.story.href, tray)
    }))
    else {
      for (const action of state.view.actions ?? []) controls.append(this.button(action.label, () => { void this.run(row, tray, { type: "action", action: action.id }) }))
      if (state.error) controls.append(this.button("Retry", () => { void this.run(row, tray, state.last) }))
    }
    controls.append(this.button("Clear conversation", () => {
      state.view = { messages: [] }; state.draft = ""; void this.run(row, tray, { type: "clear" })
    }))
    return controls
  }

  private composer(row: StoryListItem, tray: string, state: TrayState): HTMLElement {
    const form = document.createElement("form")
    form.className = "addon_tray_composer"
    const input = document.createElement("textarea")
    input.placeholder = state.view.composer ?? "Question"
    input.setAttribute("aria-label", input.placeholder)
    input.maxLength = 8000
    input.rows = 2
    input.value = state.draft
    input.disabled = !!state.controller
    input.addEventListener("input", () => { state.draft = input.value })
    const send = this.button("Ask", () => form.requestSubmit())
    send.disabled = !!state.controller
    form.addEventListener("submit", event => {
      event.preventDefault()
      if (!state.draft.trim() || state.controller) return
      const text = state.draft.trim()
      state.draft = ""
      void this.run(row, tray, { type: "submit", text })
    })
    form.append(input, send)
    return form
  }

  private button(label: string, run: () => void): HTMLButtonElement {
    const button = document.createElement("button")
    button.type = "button"
    button.className = "button"
    button.textContent = label
    button.addEventListener("click", run)
    return button
  }
}
