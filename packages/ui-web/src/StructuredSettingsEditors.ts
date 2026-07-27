import { SourceError } from "@once/app"
import { get_parser_for_url, StoryParser } from "@once/collectors"
import { parseRedirectList, Redirect } from "@once/core"

export interface SourceGroup {
  id: string
  name: string
  sources: string[]
}

export interface RedirectRow {
  match_url: string
  replace_url: string
  raw?: string
  invalid?: boolean
}

export function parseSourceGroups(lines: string[]): SourceGroup[] {
  const groups: SourceGroup[] = [{ id: "default", name: "Default", sources: [] }]
  let current = groups[0]
  for (const raw of lines) {
    const line = raw.trim()
    if (!line) continue
    if (line.startsWith("*")) {
      current = {
        id: `group-${groups.length}`,
        name: line.slice(1),
        sources: []
      }
      groups.push(current)
    } else {
      current.sources.push(line)
    }
  }
  return groups
}

export function serializeSourceGroups(groups: SourceGroup[]): string[] {
  return groups.flatMap((group, index) => [
    ...(index === 0 ? [] : [`*${group.name}`]),
    ...group.sources
  ])
}

export function parseFilterRows(text: string): string[] {
  return text.split("\n").filter((line) => line.trim() !== "")
}

export function parseRedirectRows(text: string): RedirectRow[] {
  return text.split("\n").filter((line) => line.trim() !== "").map((raw) => {
    const separator = raw.indexOf(" => ")
    if (separator < 1 || separator + 4 >= raw.length) {
      return { match_url: "", replace_url: "", raw, invalid: true }
    }
    return {
      match_url: raw.slice(0, separator).trim(),
      replace_url: raw.slice(separator + 4).trim()
    }
  })
}

export function serializeRedirectRows(rows: RedirectRow[]): string {
  return rows.map((row) => row.invalid
    ? row.raw || ""
    : `${row.match_url} => ${row.replace_url}`).join("\n")
}

function collectorFor(source: string): StoryParser | undefined {
  try {
    return get_parser_for_url(source)
  } catch {
    return undefined
  }
}

function sourceLabel(source: string): string {
  try {
    if (source.startsWith("geny:")) {
      const parts = source.split("§§")
      return new URL(parts.at(-1) || source).hostname
    }
    return new URL(source).hostname
  } catch {
    return source.length > 42 ? `${source.slice(0, 39)}…` : source
  }
}

type Section = "sources" | "filters" | "redirects"

export interface StructuredSettingsOptions {
  saveSources(values: string[]): void
  saveFilters(values: string[]): void
  saveRedirects(values: Redirect[]): void
  showSourceError(source: string): void
}

export class StructuredSettingsEditors {
  private modes = new Map<Section, "list" | "text">()
  private baselines = new Map<Section, string>()
  private errors = new Map<string, SourceError>()
  private sourceGroups: SourceGroup[] = []
  private filters: string[] = []
  private redirects: RedirectRow[] = []
  private roots = new Map<Section, HTMLElement>()
  private detailSections = new Set<Section>()
  private dragScroll = new WeakMap<HTMLElement, {
    frame: number | null
    velocity: number
  }>()
  private rowSequence = 0

  constructor(private options: StructuredSettingsOptions) {
    for (const section of ["sources", "filters", "redirects"] as const) {
      this.install(section)
      this.modes.set(section, "list")
    }
  }

  private textarea(section: Section): HTMLTextAreaElement {
    const id = section === "sources" ? "sources_area"
      : section === "filters" ? "filter_area" : "redirect_area"
    const element = document.getElementById(id)
    if (!(element instanceof HTMLTextAreaElement)) {
      throw new Error(`Missing structured settings textarea #${id}`)
    }
    return element
  }

  private install(section: Section): void {
    const textarea = this.textarea(section)
    const block = textarea.closest<HTMLElement>(".settings_editor_block")
    const input = textarea.closest<HTMLElement>(".input_container")
    const actions = block?.querySelector<HTMLElement>(".settings_actions")
    const label = block?.querySelector<HTMLElement>(".settings_block_label")
    if (!block || !input || !actions || !label) return

    const header = document.createElement("div")
    header.className = "structured_settings_header"
    label.replaceWith(header)
    header.append(label)
    const toggle = document.createElement("button")
    toggle.type = "button"
    toggle.className = "structured_mode_toggle"
    toggle.dataset.testid = `${section}-mode-toggle`
    toggle.textContent = "Edit as text"
    toggle.addEventListener("click", () => this.toggleMode(section))
    header.append(toggle)

    const root = document.createElement("div")
    root.className = "structured_settings"
    root.dataset.structuredSection = section
    root.dataset.testid = `${section}-structured-list`
    input.before(root)
    this.roots.set(section, root)
    this.installDragAutoScroll(root)
    const listActions = document.createElement("div")
    listActions.className = "structured_list_actions"
    listActions.dataset.structuredActions = section
    actions.classList.add(`structured_actions_${section}`)
    actions.prepend(listActions)
    input.hidden = true
    actions.classList.add("structured_text_actions")
    this.updateActionVisibility(section)
  }

  private toggleMode(section: Section): void {
    const mode = this.modes.get(section) || "list"
    if (mode === "text") {
      const textarea = this.textarea(section)
      if (textarea.value !== this.baselines.get(section) &&
          !window.confirm("Discard unsaved text changes and return to the list?")) {
        return
      }
      textarea.value = this.baselines.get(section) || textarea.value
      textarea.dispatchEvent(new Event("input"))
      this.modes.set(section, "list")
      this.read(section)
      this.render(section)
    } else {
      this.baselines.set(section, this.textarea(section).value)
      this.modes.set(section, "text")
    }
    this.updateActionVisibility(section)
  }

  private updateActionVisibility(section: Section): void {
    const textarea = this.textarea(section)
    const block = textarea.closest<HTMLElement>(".settings_editor_block")
    const mode = this.modes.get(section) || "list"
    const root = this.roots.get(section)
    const input = textarea.closest<HTMLElement>(".input_container")
    if (root) root.hidden = mode === "text"
    if (input) input.hidden = mode === "list"
    block?.querySelector<HTMLElement>(".structured_mode_toggle")?.replaceChildren(
      document.createTextNode(mode === "list" ? "Edit as text" : "Edit as list")
    )
    const actions = block?.querySelector<HTMLElement>(".settings_actions")
    if (actions) {
      for (const child of Array.from(actions.children)) {
        const element = child as HTMLElement
        const isPicker = element.id === "pick_source_button" ||
          element.id === "pick_source_status"
        const isListActions = element.dataset.structuredActions === section
        element.hidden = mode === "list"
          ? !isPicker && !isListActions
          : isListActions
      }
    }
  }

  sync(section: Section): void {
    const textarea = this.textarea(section)
    this.baselines.set(section, textarea.value)
    if (this.modes.get(section) === "list") {
      this.read(section)
      this.render(section)
    }
  }

  private read(section: Section): void {
    const text = this.textarea(section).value
    if (section === "sources") this.sourceGroups = parseSourceGroups(text.split("\n"))
    if (section === "filters") this.filters = parseFilterRows(text)
    if (section === "redirects") this.redirects = parseRedirectRows(text)
  }

  setErrors(errors: SourceError[]): void {
    this.errors = new Map(errors.map((error) => [error.url.trim(), error]))
    if (this.modes.get("sources") === "list") this.render("sources")
  }

  isTextMode(section: Section): boolean {
    return this.modes.get(section) === "text"
  }

  focusSource(source: string): boolean {
    if (this.isTextMode("sources")) return false
    const groupIndex = this.sourceGroups.findIndex((group) =>
      group.sources.some((entry) => entry.trim() === source.trim()))
    if (groupIndex < 0) {
      this.announce("That story source is no longer in settings.")
      return true
    }
    const root = this.roots.get("sources")
    const details = root?.querySelector<HTMLDetailsElement>(
      `[data-group-index="${groupIndex}"]`
    )
    if (details) details.open = true
    const buttons = Array.from(root?.querySelectorAll<HTMLButtonElement>(
      "[data-source-value]"
    ) || [])
    const target = buttons.find((button) => button.dataset.sourceValue === source.trim())
    if (target) {
      target.focus({ preventScroll: true })
      target.scrollIntoView({ block: "center" })
      target.classList.add("structured_row_target")
      window.setTimeout(() => target.classList.remove("structured_row_target"), 1600)
    }
    return true
  }

  focusFilter(filter: string): boolean {
    if (this.isTextMode("filters")) return false
    const root = this.roots.get("filters")
    const target = Array.from(root?.querySelectorAll<HTMLButtonElement>(
      "[data-filter-value]"
    ) || []).find((button) => button.dataset.filterValue === filter)
    target?.focus({ preventScroll: true })
    target?.scrollIntoView({ block: "center" })
    target?.click()
    return true
  }

  /**
   * Unwind an item/group editor before SettingsPanel closes the whole section.
   * Mobile's native back handling clicks the same settings back button, so this
   * covers both the visible header control and the platform back gesture.
   */
  handleBack(section: string | null): boolean {
    if (section !== "sources" && section !== "filters" &&
        section !== "redirects") {
      return false
    }
    if (!this.detailSections.has(section)) return false
    this.detailSections.delete(section)
    this.read(section)
    this.render(section)
    this.roots.get(section)?.querySelector<HTMLElement>(
      ".structured_toolbar button, .structured_row_main"
    )?.focus()
    return true
  }

  private announce(message: string): void {
    let status = document.getElementById("structured_settings_status")
    if (!status) {
      status = document.createElement("div")
      status.id = "structured_settings_status"
      status.className = "visually_hidden"
      status.setAttribute("role", "status")
      status.setAttribute("aria-live", "polite")
      document.body.append(status)
    }
    status.textContent = message
  }

  private render(section: Section): void {
    const root = this.roots.get(section)
    if (!root) return
    this.detailSections.delete(section)
    root.textContent = ""
    if (section === "sources") this.renderSources(root)
    if (section === "filters") this.renderSimpleList(root, section, this.filters)
    if (section === "redirects") this.renderRedirects(root)
  }

  private actionButton(label: string, action: () => void, testid?: string): HTMLButtonElement {
    const button = document.createElement("button")
    button.type = "button"
    button.textContent = label
    if (testid) button.dataset.testid = testid
    button.addEventListener("click", action)
    return button
  }

  private installDragAutoScroll(root: HTMLElement): void {
    const state = { frame: null as number | null, velocity: 0 }
    this.dragScroll.set(root, state)
    const stop = () => {
      state.velocity = 0
      if (state.frame !== null) cancelAnimationFrame(state.frame)
      state.frame = null
    }
    const step = () => {
      if (state.velocity === 0) {
        state.frame = null
        return
      }
      const previous = root.scrollTop
      root.scrollTop += state.velocity
      if (root.scrollTop === previous) {
        stop()
        return
      }
      state.frame = requestAnimationFrame(step)
    }
    root.addEventListener("dragover", (event) => {
      if (!event.dataTransfer) return
      event.preventDefault()
      const bounds = root.getBoundingClientRect()
      const edge = Math.min(88, Math.max(48, bounds.height * 0.16))
      const distanceFromTop = event.clientY - bounds.top
      const distanceFromBottom = bounds.bottom - event.clientY
      let velocity = 0
      if (distanceFromTop < edge) {
        const intensity = Math.min(
          1,
          Math.max(0, 1 - distanceFromTop / edge)
        )
        velocity = -Math.max(3, Math.round(22 * intensity))
      } else if (distanceFromBottom < edge) {
        const intensity = Math.min(
          1,
          Math.max(0, 1 - distanceFromBottom / edge)
        )
        velocity = Math.max(3, Math.round(22 * intensity))
      }
      state.velocity = velocity
      if (velocity === 0) {
        stop()
      } else if (state.frame === null) {
        state.frame = requestAnimationFrame(step)
      }
    })
    root.addEventListener("dragleave", (event) => {
      const next = event.relatedTarget
      if (next instanceof Node && root.contains(next)) return
      stop()
    })
    root.addEventListener("drop", stop)
    root.addEventListener("dragend", stop)
  }

  private renderSources(root: HTMLElement): void {
    const toolbar = this.listActions("sources")
    toolbar?.append(
      this.actionButton("Add source", () => this.editSource(root), "add-source"),
      this.actionButton("Add group", () => this.editGroup(root), "add-source-group")
    )

    this.sourceGroups.forEach((group, groupIndex) => {
      const details = document.createElement("details")
      details.className = "structured_group"
      details.open = true
      details.dataset.groupIndex = String(groupIndex)
      const summary = document.createElement("summary")
      const name = document.createElement("strong")
      name.textContent = group.name
      summary.append(name)
      if (groupIndex > 0) {
        const controls = document.createElement("span")
        controls.className = "structured_group_actions"
        controls.addEventListener("click", (event) => event.preventDefault())
        controls.append(
          this.actionButton("Edit", () => this.editGroup(root, groupIndex)),
          this.actionButton("↑", () => this.moveGroup(groupIndex, -1), undefined),
          this.actionButton("↓", () => this.moveGroup(groupIndex, 1), undefined),
          this.actionButton("Delete", () => this.deleteGroup(root, groupIndex))
        )
        summary.append(controls)
      }
      details.append(summary)
      const list = document.createElement("div")
      list.className = "structured_rows"
      group.sources.forEach((source, sourceIndex) => {
        list.append(this.sourceRow(root, source, groupIndex, sourceIndex))
      })
      if (group.sources.length === 0) {
        const empty = document.createElement("p")
        empty.className = "structured_empty"
        empty.textContent = "No sources"
        list.append(empty)
      }
      details.append(list)
      root.append(details)
    })
  }

  private sourceRow(
    root: HTMLElement,
    source: string,
    groupIndex: number,
    sourceIndex: number
  ): HTMLElement {
    const row = document.createElement("div")
    row.className = "structured_row"
    row.draggable = true
    row.dataset.rowKey = `source-${++this.rowSequence}`
    const parser = collectorFor(source)
    const badge = document.createElement("span")
    badge.className = "collector_badge"
    badge.textContent = parser?.options.type || "?"
    badge.title = parser?.options.description || "Unknown collector"
    if (parser?.options.colors?.[0]) {
      badge.style.backgroundColor = parser.options.colors[0]
      badge.style.color = parser.options.colors[1]
    }
    const open = document.createElement("button")
    open.type = "button"
    open.className = "structured_row_main"
    open.dataset.sourceValue = source.trim()
    open.dataset.testid = "source-row"
    open.title = source
    open.setAttribute("aria-label", `Edit ${source}`)
    const primary = document.createElement("span")
    primary.className = "structured_row_primary"
    primary.textContent = sourceLabel(source)
    const secondary = document.createElement("span")
    secondary.className = "structured_row_secondary"
    secondary.textContent = source
    open.append(primary, secondary)
    open.addEventListener("click", () =>
      this.editSource(root, groupIndex, sourceIndex))
    const error = this.errors.get(source.trim())
    if (error) {
      const issue = this.actionButton(
        error.type === "warning" ? "⚠" : "!",
        () => this.options.showSourceError(source),
        "source-error"
      )
      issue.className = `structured_issue ${error.type}`
      issue.title = `Open ${error.type} details`
      row.append(badge, open, issue)
    } else {
      row.append(badge, open)
    }
    const moves = document.createElement("span")
    moves.className = "structured_move_actions"
    moves.append(
      this.actionButton("↑", () => this.moveSource(groupIndex, sourceIndex, -1)),
      this.actionButton("↓", () => this.moveSource(groupIndex, sourceIndex, 1))
    )
    row.append(moves)
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/plain", `${groupIndex}:${sourceIndex}`)
    })
    row.addEventListener("dragover", (event) => event.preventDefault())
    row.addEventListener("drop", (event) => {
      event.preventDefault()
      const [fromGroup, fromIndex] = (event.dataTransfer?.getData("text/plain") || "")
        .split(":").map(Number)
      if (Number.isFinite(fromGroup) && Number.isFinite(fromIndex)) {
        const [value] = this.sourceGroups[fromGroup].sources.splice(fromIndex, 1)
        let destination = sourceIndex
        if (fromGroup === groupIndex && fromIndex < sourceIndex) destination--
        this.sourceGroups[groupIndex].sources.splice(destination, 0, value)
        this.saveSources()
      }
    })
    return row
  }

  private editSource(root: HTMLElement, groupIndex = 0, sourceIndex?: number): void {
    const current = sourceIndex === undefined
      ? "" : this.sourceGroups[groupIndex].sources[sourceIndex]
    this.showForm(root, "Source", [
      ["Source", current],
      ["Group", String(groupIndex)]
    ], (values) => {
      const value = values[0].trim()
      const targetGroup = Number(values[1])
      if (!value || !this.sourceGroups[targetGroup]) return false
      if (sourceIndex !== undefined) {
        this.sourceGroups[groupIndex].sources.splice(sourceIndex, 1)
      }
      if (sourceIndex !== undefined && targetGroup === groupIndex) {
        this.sourceGroups[targetGroup].sources.splice(sourceIndex, 0, value)
      } else {
        this.sourceGroups[targetGroup].sources.push(value)
      }
      this.saveSources()
      return true
    }, sourceIndex === undefined ? undefined : () => {
      if (!window.confirm("Delete this story source?")) return
      this.sourceGroups[groupIndex].sources.splice(sourceIndex, 1)
      this.saveSources()
    }, this.sourceGroups.map((group, index) => [String(index), group.name]))
  }

  private editGroup(root: HTMLElement, groupIndex?: number): void {
    this.showForm(root, "Group", [["Group name",
      groupIndex === undefined ? "" : this.sourceGroups[groupIndex].name]], (values) => {
      const name = values[0].trim()
      if (!name) return false
      if (groupIndex === undefined) {
        this.sourceGroups.push({
          id: `group-${Date.now()}`,
          name,
          sources: []
        })
      } else {
        this.sourceGroups[groupIndex].name = name
      }
      this.saveSources()
      return true
    })
  }

  private deleteGroup(root: HTMLElement, groupIndex: number): void {
    const group = this.sourceGroups[groupIndex]
    if (!group.sources.length) {
      if (window.confirm(`Delete group “${group.name}”?`)) {
        this.sourceGroups.splice(groupIndex, 1)
        this.saveSources()
      }
      return
    }
    root.textContent = ""
    this.detailSections.add("sources")
    const dialog = document.createElement("div")
    dialog.className = "structured_form"
    dialog.setAttribute("role", "dialog")
    const title = document.createElement("h3")
    title.textContent = `Delete “${group.name}”?`
    const explanation = document.createElement("p")
    explanation.textContent = "Choose what should happen to the sources in this group."
    dialog.append(title, explanation)
    this.listActions("sources")?.append(
      this.actionButton("Remove group and move sources to Default", () => {
        this.sourceGroups[0].sources.push(...group.sources)
        this.sourceGroups.splice(groupIndex, 1)
        this.saveSources()
      }),
      this.actionButton("Remove group and its sources", () => {
        if (!window.confirm(`Permanently delete ${group.sources.length} sources?`)) return
        this.sourceGroups.splice(groupIndex, 1)
        this.saveSources()
      }),
      this.actionButton("Cancel", () => this.render("sources")))
    root.append(dialog)
  }

  private moveGroup(index: number, amount: number): void {
    const target = index + amount
    if (target < 1 || target >= this.sourceGroups.length) return
    const [group] = this.sourceGroups.splice(index, 1)
    this.sourceGroups.splice(target, 0, group)
    this.saveSources()
  }

  private moveSource(group: number, index: number, amount: number): void {
    const target = index + amount
    const values = this.sourceGroups[group].sources
    if (target < 0 || target >= values.length) return
    const [value] = values.splice(index, 1)
    values.splice(target, 0, value)
    this.saveSources()
  }

  private saveSources(): void {
    const values = serializeSourceGroups(this.sourceGroups)
    this.textarea("sources").value = values.join("\n")
    this.baselines.set("sources", this.textarea("sources").value)
    this.options.saveSources(values)
    this.render("sources")
  }

  private renderSimpleList(root: HTMLElement, section: "filters", values: string[]): void {
    this.listActions(section)?.append(this.actionButton("Add filter", () =>
      this.editFilterInline(root), "add-filter"))
    const rows = document.createElement("div")
    rows.className = "structured_rows"
    values.forEach((value, index) => {
      const row = document.createElement("div")
      row.className = "structured_row"
      row.draggable = true
      row.dataset.filterIndex = String(index)
      const open = this.actionButton(value, () =>
        this.editFilterInline(root, index), "filter-row")
      open.className = "structured_row_main"
      open.dataset.filterValue = value
      const remove = this.actionButton("×", () => {
        if (!window.confirm(`Delete filter “${value}”?`)) return
        this.filters.splice(index, 1)
        this.saveFilters()
      }, "remove-filter")
      remove.className = "structured_remove"
      remove.title = `Delete filter ${value}`
      remove.setAttribute("aria-label", remove.title)
      row.append(
        open,
        remove,
        this.moveButtons(() => this.moveFilter(index, -1),
          () => this.moveFilter(index, 1))
      )
      row.addEventListener("dragstart", (event) => {
        row.classList.add("structured_row_dragging")
        event.dataTransfer?.setData("text/plain", String(index))
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
      })
      row.addEventListener("dragend", () => {
        row.classList.remove("structured_row_dragging")
        rows.querySelectorAll(".structured_row_drop_target").forEach((target) =>
          target.classList.remove("structured_row_drop_target"))
      })
      row.addEventListener("dragenter", (event) => {
        event.preventDefault()
        row.classList.add("structured_row_drop_target")
      })
      row.addEventListener("dragleave", () =>
        row.classList.remove("structured_row_drop_target"))
      row.addEventListener("dragover", (event) => {
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
      })
      row.addEventListener("drop", (event) => {
        event.preventDefault()
        row.classList.remove("structured_row_drop_target")
        const from = Number(event.dataTransfer?.getData("text/plain"))
        if (!Number.isInteger(from) || from === index ||
            from < 0 || from >= this.filters.length) {
          return
        }
        const [moved] = this.filters.splice(from, 1)
        this.filters.splice(index, 0, moved)
        this.saveFilters()
      })
      rows.append(row)
    })
    root.append(rows)
  }

  private editFilterInline(root: HTMLElement, index?: number): void {
    const rows = root.querySelector<HTMLElement>(".structured_rows")
    if (!rows) return
    this.detailSections.add("filters")
    const isNew = index === undefined
    const row = isNew
      ? document.createElement("div")
      : rows.children.item(index) as HTMLElement | null
    if (!row) return
    if (isNew) {
      row.className = "structured_row"
      rows.append(row)
      row.scrollIntoView({ block: "nearest" })
    }

    const original = isNew ? "" : this.filters[index]
    row.textContent = ""
    row.classList.add("structured_row_editing")
    const input = document.createElement("input")
    input.type = "text"
    input.className = "structured_inline_input"
    input.dataset.testid = "filter-inline-input"
    input.value = original
    input.setAttribute("aria-label", isNew ? "New filter" : `Edit filter ${original}`)
    const validation = document.createElement("span")
    validation.className = "structured_inline_validation"
    validation.setAttribute("role", "alert")
    const save = () => {
      const value = input.value
      if (!value.trim()) {
        if (isNew) {
          this.render("filters")
        } else {
          validation.textContent = "Filter cannot be empty"
          input.focus()
        }
        return
      }
      if (isNew) this.filters.push(value)
      else this.filters[index] = value
      this.saveFilters()
    }
    const cancel = () => this.render("filters")
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault()
        save()
      } else if (event.key === "Escape") {
        event.preventDefault()
        cancel()
      }
    })
    input.addEventListener("blur", () => {
      // Let a pointer press on an explicit action complete before deciding
      // whether focus really left the inline editor.
      window.setTimeout(() => {
        if (document.activeElement === input || !row.isConnected) return
        save()
      }, 0)
    })
    const accept = this.actionButton("Save", save, "save-inline-filter")
    accept.className = "structured_inline_action"
    const dismiss = this.actionButton("Cancel", cancel)
    dismiss.className = "structured_inline_action"
    row.append(input, validation)
    this.listActions("filters")?.append(accept, dismiss)
    input.focus()
    input.select()
  }

  private moveFilter(index: number, amount: number): void {
    const target = index + amount
    if (target < 0 || target >= this.filters.length) return
    const [value] = this.filters.splice(index, 1)
    this.filters.splice(target, 0, value)
    this.saveFilters()
  }

  private saveFilters(): void {
    this.textarea("filters").value = this.filters.join("\n")
    this.baselines.set("filters", this.textarea("filters").value)
    this.options.saveFilters([...this.filters])
    this.render("filters")
  }

  private renderRedirects(root: HTMLElement): void {
    this.listActions("redirects")?.append(this.actionButton("Add redirect", () =>
      this.editRedirect(root), "add-redirect"))
    const rows = document.createElement("div")
    rows.className = "structured_rows"
    this.redirects.forEach((redirect, index) => {
      const row = document.createElement("div")
      row.className = `structured_row${redirect.invalid ? " invalid" : ""}`
      const open = document.createElement("button")
      open.type = "button"
      open.className = "structured_row_main"
      open.dataset.testid = "redirect-row"
      const match = document.createElement("span")
      match.className = "structured_row_primary"
      match.textContent = redirect.invalid ? redirect.raw || "" : redirect.match_url
      const replacement = document.createElement("span")
      replacement.className = "structured_row_secondary"
      replacement.textContent = redirect.invalid
        ? "Invalid redirect — edit as text or repair this row"
        : `→ ${redirect.replace_url}`
      open.append(match, replacement)
      open.addEventListener("click", () => this.editRedirect(root, index))
      row.append(open, this.moveButtons(() => this.moveRedirect(index, -1),
        () => this.moveRedirect(index, 1)))
      rows.append(row)
    })
    root.append(rows)
  }

  private editRedirect(root: HTMLElement, index?: number): void {
    const row = index === undefined
      ? { match_url: "", replace_url: "" } : this.redirects[index]
    this.showForm(root, "Redirect", [
      ["Match URL expression", row.match_url],
      ["Replace with", row.replace_url]
    ], (values) => {
      if (!values[0].trim() || !values[1].trim()) return false
      const next = { match_url: values[0], replace_url: values[1] }
      if (index === undefined) this.redirects.push(next)
      else this.redirects[index] = next
      this.saveRedirects()
      return true
    }, index === undefined ? undefined : () => {
      if (!window.confirm("Delete this redirect?")) return
      this.redirects.splice(index, 1)
      this.saveRedirects()
    })
  }

  private moveRedirect(index: number, amount: number): void {
    const target = index + amount
    if (target < 0 || target >= this.redirects.length) return
    const [value] = this.redirects.splice(index, 1)
    this.redirects.splice(target, 0, value)
    this.saveRedirects()
  }

  private saveRedirects(): void {
    const text = serializeRedirectRows(this.redirects)
    this.textarea("redirects").value = text
    this.baselines.set("redirects", text)
    this.options.saveRedirects(parseRedirectList(text))
    this.render("redirects")
  }

  private moveButtons(up: () => void, down: () => void): HTMLElement {
    const controls = document.createElement("span")
    controls.className = "structured_move_actions"
    controls.append(this.actionButton("↑", up), this.actionButton("↓", down))
    return controls
  }

  private listActions(section: Section): HTMLElement | null {
    const actions = document.querySelector<HTMLElement>(
      `[data-structured-actions="${section}"]`
    )
    if (actions) actions.textContent = ""
    return actions
  }

  private showForm(
    root: HTMLElement,
    titleText: string,
    fields: Array<[string, string]>,
    save: (values: string[]) => boolean,
    remove?: () => void,
    choices?: Array<[string, string]>
  ): void {
    const section = root.dataset.structuredSection as Section
    this.detailSections.add(section)
    root.textContent = ""
    const form = document.createElement("form")
    form.className = "structured_form"
    form.dataset.testid = "structured-item-form"
    const title = document.createElement("h3")
    title.textContent = titleText
    form.append(title)
    const inputs: Array<HTMLInputElement | HTMLSelectElement> = []
    fields.forEach(([labelText, value], fieldIndex) => {
      const label = document.createElement("label")
      label.textContent = labelText
      let input: HTMLInputElement | HTMLSelectElement
      if (choices && fieldIndex === fields.length - 1) {
        input = document.createElement("select")
        choices.forEach(([choiceValue, choiceLabel]) => {
          const option = document.createElement("option")
          option.value = choiceValue
          option.textContent = choiceLabel
          input.append(option)
        })
      } else {
        input = document.createElement("input")
        input.type = "text"
      }
      input.value = value
      input.required = true
      label.append(input)
      inputs.push(input)
      form.append(label)
    })
    const error = document.createElement("p")
    error.className = "structured_validation"
    error.setAttribute("role", "alert")
    const actions = document.createElement("div")
    actions.className = "structured_form_actions"
    actions.append(this.actionButton("Save", () => {
      if (!form.reportValidity()) return
      if (!save(inputs.map((input) => input.value))) {
        error.textContent = "Complete all required fields."
      }
    }, "structured-save"))
    actions.append(this.actionButton("Cancel", () => {
      this.read(section)
      this.render(section)
    }))
    if (remove) actions.append(this.actionButton("Delete", remove, "structured-delete"))
    form.addEventListener("submit", (event) => {
      event.preventDefault()
      actions.querySelector<HTMLButtonElement>("[data-testid='structured-save']")?.click()
    })
    form.append(error)
    this.listActions(section)?.append(actions)
    root.append(form)
    inputs[0]?.focus()
  }
}
