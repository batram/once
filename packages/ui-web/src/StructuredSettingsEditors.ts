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

function highlightMatches(
  element: HTMLElement,
  value: string,
  query: string
): void {
  element.textContent = ""
  if (!query) {
    element.textContent = value
    return
  }
  const normalizedValue = value.toLowerCase()
  let start = 0
  let match = normalizedValue.indexOf(query)
  while (match !== -1) {
    element.append(document.createTextNode(value.slice(start, match)))
    const mark = document.createElement("mark")
    mark.textContent = value.slice(match, match + query.length)
    element.append(mark)
    start = match + query.length
    match = normalizedValue.indexOf(query, start)
  }
  element.append(document.createTextNode(value.slice(start)))
}

type Section = "sources" | "filters" | "redirects"

export interface StructuredSettingsOptions {
  saveSources(values: string[], reloadStories?: boolean): void
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
  private headers = new Map<Section, HTMLElement>()
  private toggles = new Map<Section, HTMLButtonElement>()
  private searchQueries = new Map<Section, string>()
  private sourceGroupOpen = new Map<string, boolean>()
  private detailSections = new Set<Section>()
  private pendingFilterRevealIndex: number | null = null
  private filterRevealTimer: number | null = null
  private dragScroll = new WeakMap<HTMLElement, {
    frame: number | null
    velocity: number
  }>()
  private rowSequence = 0
  private sourceRenderGeneration = 0

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
    this.headers.set(section, header)
    const toggle = document.createElement("button")
    toggle.type = "button"
    toggle.className = "structured_mode_toggle"
    toggle.dataset.testid = `${section}-mode-toggle`
    toggle.textContent = "Edit as text"
    toggle.addEventListener("click", () => this.toggleMode(section))
    header.append(toggle)
    this.toggles.set(section, toggle)

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
    const toggle = this.toggles.get(section)
    if (toggle) {
      const action = mode === "list" ? "Edit as text" : "Edit as list"
      const compact = toggle.classList.contains(
        "structured_mode_toggle_topbar"
      )
      toggle.textContent = compact
        ? mode === "list" ? "TXT" : "UI"
        : action
      toggle.title = action
      toggle.setAttribute("aria-label", action)
    }
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

  setActiveSection(active: string | null): void {
    const bar = document.querySelector<HTMLElement>("#settings_panel .bar")
    if (!bar) return
    for (const section of ["sources", "filters", "redirects"] as const) {
      const toggle = this.toggles.get(section)
      const header = this.headers.get(section)
      if (!toggle || !header) continue
      const isActive = section === active
      if (isActive) {
        bar.append(toggle)
      } else {
        header.append(toggle)
      }
      toggle.classList.toggle("structured_mode_toggle_topbar", isActive)
      header.classList.toggle("structured_toggle_moved", isActive)
      this.updateActionVisibility(section)
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
    if (section === "sources") {
      const previous = this.sourceGroups
      const parsed = parseSourceGroups(text.split("\n"))
      const used = new Set<number>()
      parsed.slice(1).forEach((group) => {
        let match = previous.findIndex((candidate, index) =>
          index > 0 &&
          !used.has(index) &&
          candidate.name === group.name &&
          candidate.sources.length === group.sources.length &&
          candidate.sources.every((source, sourceIndex) =>
            source === group.sources[sourceIndex])
        )
        if (match < 0) {
          match = previous.findIndex((candidate, index) =>
            index > 0 && !used.has(index) && candidate.name === group.name
          )
        }
        if (match > 0) {
          group.id = previous[match].id
          used.add(match)
        }
      })
      this.sourceGroups = parsed
    }
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
    if (this.detailSections.has("sources") ||
        (this.searchQueries.get("sources") || "").trim()) {
      this.detailSections.delete("sources")
      this.searchQueries.set("sources", "")
      this.read("sources")
      this.render("sources")
    }
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

  openSettingsSearchMatch(section: string, startIndex: number): boolean {
    if (section !== "sources" && section !== "filters" &&
        section !== "redirects") {
      return false
    }
    if (this.isTextMode(section)) return false

    const lines = this.textarea(section).value.split("\n")
    let offset = 0
    let targetLine = -1
    for (let index = 0; index < lines.length; index++) {
      const end = offset + lines[index].length
      if (startIndex >= offset && startIndex <= end) {
        targetLine = index
        break
      }
      offset = end + 1
    }
    if (targetLine < 0) return true

    this.searchQueries.set(section, "")
    this.read(section)
    this.render(section)
    const root = this.roots.get(section)
    if (!root) return true

    if (section === "sources") {
      let groupIndex = 0
      let sourceIndex = 0
      for (let lineIndex = 0; lineIndex <= targetLine; lineIndex++) {
        const line = lines[lineIndex].trim()
        if (!line) continue
        if (line.startsWith("*")) {
          if (lineIndex === targetLine) {
            const group = root.querySelector<HTMLDetailsElement>(
              `[data-group-index="${groupIndex + 1}"]`
            )
            if (group) {
              group.open = true
              const summary = group.querySelector<HTMLElement>("summary")
              summary?.focus({ preventScroll: true })
              summary?.scrollIntoView({ block: "center" })
              summary?.classList.add("structured_row_target")
              window.setTimeout(
                () => summary?.classList.remove("structured_row_target"),
                1600
              )
            }
            return true
          }
          groupIndex++
          sourceIndex = 0
          continue
        }
        if (lineIndex === targetLine) {
          this.editSource(root, groupIndex, sourceIndex)
          return true
        }
        sourceIndex++
      }
      return true
    }

    let rowIndex = -1
    for (let lineIndex = 0; lineIndex <= targetLine; lineIndex++) {
      if (lines[lineIndex].trim()) rowIndex++
    }
    if (rowIndex < 0) return true
    if (section === "filters") {
      this.editFilterInline(root, rowIndex)
      const input = root.querySelector<HTMLInputElement>(
        "[data-testid='filter-inline-input']"
      )
      const row = input?.closest<HTMLElement>(".structured_row")
      row?.classList.add("structured_row_target")
      window.setTimeout(
        () => row?.classList.remove("structured_row_target"),
        1600
      )
    } else {
      this.editRedirect(root, rowIndex)
    }
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
    this.renderSearch(root, section)
    if (section === "sources") this.renderSources(root)
    if (section === "filters") this.renderSimpleList(root, section, this.filters)
    if (section === "redirects") this.renderRedirects(root)
    this.applySearch(root, section)
  }

  private renderSearch(root: HTMLElement, section: Section): void {
    const labels: Record<Section, string> = {
      sources: "story sources",
      filters: "filters",
      redirects: "redirects"
    }
    const search = document.createElement("label")
    search.className = "structured_search"
    const text = document.createElement("span")
    text.className = "visually_hidden"
    text.textContent = `Search ${labels[section]}`
    const input = document.createElement("input")
    input.type = "search"
    input.placeholder = `Search ${labels[section]}`
    input.value = this.searchQueries.get(section) || ""
    input.dataset.testid = `${section}-list-search`
    input.setAttribute("aria-label", text.textContent)
    const status = document.createElement("span")
    status.className = "structured_search_status"
    status.setAttribute("role", "status")
    status.setAttribute("aria-live", "polite")
    input.addEventListener("input", () => {
      this.searchQueries.set(section, input.value)
      this.applySearch(root, section)
    })
    search.append(text, input, status)
    root.append(search)
  }

  private applySearch(root: HTMLElement, section: Section): void {
    const query = (this.searchQueries.get(section) || "").trim().toLowerCase()
    let visible = 0
    if (section === "sources") {
      root.querySelectorAll<HTMLDetailsElement>(".structured_group").forEach(
        (group) => {
          const groupMatches = (group.dataset.searchValue || "").includes(query)
          const groupName = group.querySelector<HTMLElement>(
            ".structured_group_name"
          )
          if (groupName) {
            highlightMatches(
              groupName,
              groupName.dataset.searchText || "",
              query
            )
          }
          let groupVisible = false
          group.querySelectorAll<HTMLElement>(".structured_row").forEach((row) => {
            const matches = !query || groupMatches ||
              (row.dataset.searchValue || "").includes(query)
            row.hidden = !matches
            row.querySelectorAll<HTMLElement>("[data-search-text]").forEach(
              (element) => highlightMatches(
                element,
                element.dataset.searchText || "",
                query
              )
            )
            if (matches) {
              visible++
              groupVisible = true
            }
          })
          const empty = group.querySelector<HTMLElement>(".structured_empty")
          if (empty) empty.hidden = Boolean(query) && !groupMatches
          group.hidden = Boolean(query) && !groupMatches && !groupVisible
          if (query && !group.hidden) group.open = true
        }
      )
    } else {
      root.querySelectorAll<HTMLElement>(".structured_row").forEach((row) => {
        const matches = !query ||
          (row.dataset.searchValue || "").includes(query)
        row.hidden = !matches
        if (matches) visible++
      })
    }
    const status = root.querySelector<HTMLElement>(".structured_search_status")
    if (status) status.textContent = query
      ? `${visible} ${visible === 1 ? "result" : "results"}`
      : ""
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
    let scroller: HTMLElement = root
    this.dragScroll.set(root, state)
    const scrollContainer = () => {
      const overflow = getComputedStyle(root).overflowY
      if ((overflow === "auto" || overflow === "scroll") &&
          root.scrollHeight > root.clientHeight) {
        return root
      }
      return root.closest<HTMLElement>(".settings_section") || root
    }
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
      const previous = scroller.scrollTop
      scroller.scrollTop += state.velocity
      if (scroller.scrollTop === previous) {
        stop()
        return
      }
      state.frame = requestAnimationFrame(step)
    }
    const update = (event: DragEvent) => {
      if (!event.dataTransfer) return
      if (event.currentTarget === section &&
          event.target instanceof Node &&
          root.contains(event.target)) {
        return
      }
      event.preventDefault()
      scroller = scrollContainer()
      const bounds = scroller.getBoundingClientRect()
      const search = root.querySelector<HTMLElement>(".structured_search")
      const searchBounds = search?.getBoundingClientRect()
      const visibleTop = Math.max(
        bounds.top,
        searchBounds && searchBounds.bottom <= bounds.bottom
          ? searchBounds.bottom
          : bounds.top
      )
      const visibleBottom = bounds.bottom
      const visibleHeight = Math.max(1, visibleBottom - visibleTop)
      // Keep a generous, stable activation band at each visible edge. The old
      // root-relative percentage shrank as groups collapsed or the list moved.
      const edge = Math.min(128, Math.max(72, visibleHeight * 0.24))
      const distanceFromTop = event.clientY - visibleTop
      const distanceFromBottom = visibleBottom - event.clientY
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
      } else {
        // Electron may throttle animation frames during a native HTML drag.
        // Move on every dragover as well so the full edge band stays responsive.
        scroller.scrollTop += velocity
        if (state.frame === null) state.frame = requestAnimationFrame(step)
      }
    }
    root.addEventListener("dragover", update)
    const section = root.closest<HTMLElement>(".settings_section")
    if (section && section !== root) section.addEventListener("dragover", update)
    root.addEventListener("dragleave", (event) => {
      const next = event.relatedTarget
      if (next instanceof Node &&
          (root.contains(next) || section?.contains(next))) return
      stop()
    })
    const eventRoot = section || root
    eventRoot.addEventListener("drop", stop)
    eventRoot.addEventListener("dragend", stop)
  }

  private renderSources(root: HTMLElement): void {
    const renderGeneration = ++this.sourceRenderGeneration
    const toolbar = this.listActions("sources")
    toolbar?.append(
      this.actionButton("Add source", () => this.editSource(root), "add-source"),
      this.actionButton("Add group", () => this.editGroup(root), "add-source-group")
    )

    let draggedGroupIndex: number | null = null
    let expandedSnapshot: Map<string, boolean> | null = null
    let suppressGroupToggle = false
    let collapseFrame: number | null = null
    let pendingGroupDestination: number | null = null
    let groupDropCommitted = false
    const revealGroup = (groupId: string) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          const group = root.querySelector<HTMLElement>(
            `[data-group-id="${CSS.escape(groupId)}"]`
          )
          const summary = group?.querySelector<HTMLElement>("summary")
          summary?.focus({ preventScroll: true })
          group?.scrollIntoView({ block: "nearest" })
        })
      })
    }
    const clearDropTargets = () => {
      root.querySelectorAll<HTMLElement>(
        ".structured_group_drop_before, .structured_group_drop_after"
      ).forEach((group) => group.classList.remove(
        "structured_group_drop_before",
        "structured_group_drop_after"
      ))
    }
    const restoreExpandedState = () => {
      if (collapseFrame !== null) cancelAnimationFrame(collapseFrame)
      collapseFrame = null
      if (expandedSnapshot) {
        for (const [id, open] of expandedSnapshot) {
          this.sourceGroupOpen.set(id, open)
        }
        root.querySelectorAll<HTMLDetailsElement>(".structured_group").forEach(
          (group) => {
            const id = group.dataset.groupId
            if (id && expandedSnapshot?.has(id)) {
              group.open = expandedSnapshot.get(id) || false
            }
          }
        )
      }
      clearDropTargets()
      root.classList.remove("structured_group_drag_active")
      draggedGroupIndex = null
      expandedSnapshot = null
      window.setTimeout(() => {
        suppressGroupToggle = false
      }, 0)
    }
    const commitGroupDrop = (destination: number) => {
      if (groupDropCommitted || draggedGroupIndex === null) return
      groupDropCommitted = true
      const from = draggedGroupIndex
      const draggedId = this.sourceGroups[from].id
      restoreExpandedState()
      if (destination !== from) {
        const [moved] = this.sourceGroups.splice(from, 1)
        this.sourceGroups.splice(destination, 0, moved)
        this.saveSources(false)
      }
      revealGroup(draggedId)
    }

    this.sourceGroups.forEach((group, groupIndex) => {
      const details = document.createElement("details")
      details.className = "structured_group"
      details.open = this.sourceGroupOpen.get(group.id) ?? true
      details.dataset.groupIndex = String(groupIndex)
      details.dataset.groupId = group.id
      details.dataset.searchValue = group.name.toLowerCase()
      details.addEventListener("toggle", () => {
        if (!suppressGroupToggle &&
            renderGeneration === this.sourceRenderGeneration) {
          this.sourceGroupOpen.set(group.id, details.open)
        }
      })
      const summary = document.createElement("summary")
      let suppressNextSummaryClick = false
      const name = document.createElement("strong")
      name.className = "structured_group_name"
      name.textContent = group.name
      name.dataset.searchText = group.name
      name.draggable = groupIndex > 0
      if (groupIndex > 0) {
        name.title = `Drag to reorder ${group.name}`
        name.setAttribute("aria-label", `${group.name} group; drag to reorder`)
      }
      summary.append(name)
      if (groupIndex > 0) {
        const controls = document.createElement("span")
        controls.className = "structured_group_actions"
        controls.addEventListener("click", (event) => event.preventDefault())
        controls.append(
          this.actionButton("Edit", () => this.editGroup(root, groupIndex)),
          this.actionButton("Delete", () => this.deleteGroup(root, groupIndex))
        )
        summary.append(controls)
      }
      summary.addEventListener("dragover", (event) => {
        if (draggedGroupIndex !== null ||
            !this.sourceDragPosition(event.dataTransfer)) {
          return
        }
        event.preventDefault()
        event.stopPropagation()
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
        details.classList.add("structured_source_group_title_drop_target")
      })
      summary.addEventListener("dragleave", (event) => {
        const next = event.relatedTarget
        if (next instanceof Node && summary.contains(next)) return
        details.classList.remove("structured_source_group_title_drop_target")
      })
      summary.addEventListener("drop", (event) => {
        if (draggedGroupIndex !== null) return
        const position = this.sourceDragPosition(event.dataTransfer)
        if (!position) return
        event.preventDefault()
        event.stopPropagation()
        details.classList.remove("structured_source_group_title_drop_target")
        const [fromGroup, fromIndex] = position
        const origin = this.sourceGroups[fromGroup]
        if (!origin || fromIndex < 0 || fromIndex >= origin.sources.length) {
          return
        }
        const [value] = origin.sources.splice(fromIndex, 1)
        this.sourceGroups[groupIndex].sources.push(value)
        this.saveSources(false)
      })
      summary.addEventListener("click", (event) => {
        if (!suppressNextSummaryClick) return
        event.preventDefault()
        event.stopPropagation()
      }, { capture: true })
      name.addEventListener("dragstart", (event) => {
        if (groupIndex === 0) {
          event.preventDefault()
          return
        }
        draggedGroupIndex = groupIndex
        pendingGroupDestination = null
        groupDropCommitted = false
        suppressGroupToggle = true
        suppressNextSummaryClick = true
        expandedSnapshot = new Map(
          Array.from(root.querySelectorAll<HTMLDetailsElement>(
            ".structured_group"
          )).map((entry) => [
            entry.dataset.groupId || "",
            entry.open
          ])
        )
        details.classList.add("structured_group_dragging")
        event.dataTransfer?.setData(
          "application/x-once-source-group",
          String(groupIndex)
        )
        event.dataTransfer?.setData("text/plain", `group:${groupIndex}`)
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
        const startingTop = summary.getBoundingClientRect().top
        collapseFrame = requestAnimationFrame(() => {
          collapseFrame = null
          if (draggedGroupIndex !== groupIndex) return
          root.classList.add("structured_group_drag_active")
          const movedBy = summary.getBoundingClientRect().top - startingTop
          if (movedBy) root.scrollTop += movedBy
        })
      })
      name.addEventListener("dragend", (event) => {
        const draggedId = group.id
        details.classList.remove("structured_group_dragging")
        if (!groupDropCommitted &&
            pendingGroupDestination !== null &&
            event.dataTransfer?.dropEffect === "move") {
          commitGroupDrop(pendingGroupDestination)
        }
        restoreExpandedState()
        revealGroup(draggedId)
        pendingGroupDestination = null
        window.setTimeout(() => {
          suppressNextSummaryClick = false
        }, 0)
      })
      details.addEventListener("dragover", (event) => {
        if (draggedGroupIndex === null) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
        clearDropTargets()
        const bounds = details.getBoundingClientRect()
        const after = groupIndex > 0 &&
          event.clientY >= bounds.top + bounds.height / 2
        let destination = groupIndex === 0
          ? 1
          : groupIndex + (after ? 1 : 0)
        if (draggedGroupIndex < destination) destination--
        pendingGroupDestination = Math.max(
          1,
          Math.min(destination, this.sourceGroups.length - 1)
        )
        details.classList.add(
          after ? "structured_group_drop_after" : "structured_group_drop_before"
        )
      })
      details.addEventListener("drop", (event) => {
        if (draggedGroupIndex === null) return
        event.preventDefault()
        event.stopPropagation()
        const bounds = details.getBoundingClientRect()
        const after = groupIndex > 0 &&
          event.clientY >= bounds.top + bounds.height / 2
        let destination = groupIndex === 0
          ? 1
          : groupIndex + (after ? 1 : 0)
        if (draggedGroupIndex < destination) destination--
        destination = Math.max(1, Math.min(destination, this.sourceGroups.length - 1))
        commitGroupDrop(destination)
      })
      details.append(summary)
      const list = document.createElement("div")
      list.className = "structured_rows"
      list.addEventListener("dragover", (event) => {
        const position = this.sourceDragPosition(event.dataTransfer)
        if (!position) return
        event.preventDefault()
        if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
        list.classList.add("structured_source_group_drop_target")
      })
      list.addEventListener("dragleave", (event) => {
        const next = event.relatedTarget
        if (next instanceof Node && list.contains(next)) return
        list.classList.remove("structured_source_group_drop_target")
      })
      list.addEventListener("drop", (event) => {
        const position = this.sourceDragPosition(event.dataTransfer)
        if (!position) return
        event.preventDefault()
        event.stopPropagation()
        list.classList.remove("structured_source_group_drop_target")
        const [fromGroup, fromIndex] = position
        const origin = this.sourceGroups[fromGroup]
        if (!origin || fromIndex < 0 || fromIndex >= origin.sources.length) {
          return
        }
        const [value] = origin.sources.splice(fromIndex, 1)
        this.sourceGroups[groupIndex].sources.push(value)
        this.saveSources(false)
      })
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
    row.dataset.searchValue = [
      source,
      sourceLabel(source),
      parser?.options.type
    ].filter(Boolean).join(" ").toLowerCase()
    const badge = document.createElement("span")
    badge.className = "collector_badge"
    badge.textContent = parser?.options.type || "?"
    badge.dataset.searchText = badge.textContent
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
    primary.dataset.searchText = primary.textContent
    const secondary = document.createElement("span")
    secondary.className = "structured_row_secondary"
    secondary.textContent = source
    secondary.dataset.searchText = source
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
    row.addEventListener("dragstart", (event) => {
      event.dataTransfer?.setData("text/plain", `${groupIndex}:${sourceIndex}`)
    })
    row.addEventListener("dragover", (event) => event.preventDefault())
    row.addEventListener("drop", (event) => {
      event.preventDefault()
      event.stopPropagation()
      const position = this.sourceDragPosition(event.dataTransfer)
      if (position) {
        const [fromGroup, fromIndex] = position
        const [value] = this.sourceGroups[fromGroup].sources.splice(fromIndex, 1)
        let destination = sourceIndex
        if (fromGroup === groupIndex && fromIndex < sourceIndex) destination--
        this.sourceGroups[groupIndex].sources.splice(destination, 0, value)
        this.saveSources(false)
      }
    })
    return row
  }

  private sourceDragPosition(
    transfer: DataTransfer | null
  ): [number, number] | null {
    const match = transfer?.getData("text/plain").match(/^(\d+):(\d+)$/)
    if (!match) return null
    return [Number(match[1]), Number(match[2])]
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

  private saveSources(reloadStories = true): void {
    const values = serializeSourceGroups(this.sourceGroups)
    this.textarea("sources").value = values.join("\n")
    this.baselines.set("sources", this.textarea("sources").value)
    this.options.saveSources(values, reloadStories)
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
      row.dataset.searchValue = value.toLowerCase()
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
      row.append(open, remove)
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
    this.applyPendingFilterReveal()
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
      const savedIndex = index ?? this.filters.length
      if (isNew) this.filters.push(value)
      else this.filters[savedIndex] = value
      if (isNew) this.pendingFilterRevealIndex = savedIndex
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
    input.focus({ preventScroll: true })
    input.select()
    if (isNew) {
      requestAnimationFrame(() => {
        if (row.isConnected) row.scrollIntoView({ block: "center" })
      })
    }
  }

  private applyPendingFilterReveal(): void {
    const index = this.pendingFilterRevealIndex
    if (index === null) return
    if (this.filterRevealTimer !== null) {
      window.clearTimeout(this.filterRevealTimer)
      this.filterRevealTimer = null
    }
    requestAnimationFrame(() => {
      if (this.pendingFilterRevealIndex !== index) return
      const root = this.roots.get("filters")
      const row = root?.querySelector<HTMLElement>(
        `[data-filter-index="${index}"]`
      )
      const button = row?.querySelector<HTMLButtonElement>(
        "[data-filter-value]"
      )
      if (!row || !button) return
      button.focus({ preventScroll: true })
      row.scrollIntoView({ block: "center" })
      row.classList.add("structured_row_target")
      this.filterRevealTimer = window.setTimeout(() => {
        if (this.pendingFilterRevealIndex !== index) return
        this.pendingFilterRevealIndex = null
        this.filterRevealTimer = null
        const current = this.roots.get("filters")?.querySelector<HTMLElement>(
          `[data-filter-index="${index}"]`
        )
        current?.classList.remove("structured_row_target")
      }, 1600)
    })
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
      row.draggable = true
      row.dataset.searchValue = [
        redirect.raw,
        redirect.match_url,
        redirect.replace_url
      ].filter(Boolean).join(" ").toLowerCase()
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
      row.append(open)
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
            from < 0 || from >= this.redirects.length) {
          return
        }
        const [moved] = this.redirects.splice(from, 1)
        this.redirects.splice(index, 0, moved)
        this.saveRedirects()
      })
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

  private saveRedirects(): void {
    const text = serializeRedirectRows(this.redirects)
    this.textarea("redirects").value = text
    this.baselines.set("redirects", text)
    this.options.saveRedirects(parseRedirectList(text))
    this.render("redirects")
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
