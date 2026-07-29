import { SourceError } from "@once/app"
import { get_parser_for_url, StoryParser } from "@once/collectors"
import { Redirect } from "@once/core"
import { AnchoredMenuItem, openAnchoredMenu } from "./StoryAnchoredMenu"
import {
  parseSourceGroups,
  serializeSourceGroups,
  SourceGroup
} from "./structuredSettings/sourceGroups"
import {
  applyStructuredSearch,
  renderStructuredSearch,
  StructuredSettingsSection
} from "./structuredSettings/searchNavigation"
import {
  announceStructuredSettings,
  createActionButton,
  createInlineActionButton
} from "./structuredSettings/form"
import { createRedirectTester } from "./structuredSettings/redirectTester"
import { installDragAutoScroll } from "./structuredSettings/dragReorder"
import { FlatSettingsEditors } from "./structuredSettings/FlatSettingsEditors"

export { parseFilterRows } from "./structuredSettings/filters"
export {
  parseRedirectRows,
  RedirectRow,
  serializeRedirectRows
} from "./structuredSettings/redirects"
export {
  parseSourceGroups,
  serializeSourceGroups,
  SourceGroup
} from "./structuredSettings/sourceGroups"

/** Every control showForm builds: the three carry a value and take input. */
type FormField = HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement

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

type Section = StructuredSettingsSection

export interface StructuredSettingsOptions {
  saveSources(values: string[], reloadStories?: boolean): void | Promise<void>
  saveFilters(values: string[]): void
  saveRedirects(values: Redirect[]): void
  showSourceError(source: string): void
  /**
   * Retitle the settings header while a full-screen editor is open, and hide
   * the chrome that belongs to the list behind it. Passing null restores the
   * section's own title. SettingsPanel owns the header, so it owns this.
   */
  setDetailTitle?(title: string | null): void
  /**
   * URLs of the stories currently loaded, for the redirect tester's corpus
   * count. Reading them from the client rather than the DOM keeps search
   * results from being counted twice.
   */
  loadedStoryUrls?(): string[]
}

export class StructuredSettingsEditors {
  private modes = new Map<Section, "list" | "text">()
  private baselines = new Map<Section, string>()
  private errors = new Map<string, SourceError>()
  private sourceGroups: SourceGroup[] = []
  private flatEditors: FlatSettingsEditors
  private roots = new Map<Section, HTMLElement>()
  private headers = new Map<Section, HTMLElement>()
  private addButtons = new Map<Section, HTMLButtonElement>()
  private pickerStatus: HTMLElement | null = null
  private toggles = new Map<Section, HTMLButtonElement>()
  private searchQueries = new Map<Section, string>()
  private sourceGroupOpen = new Map<string, boolean>()
  private detailSections = new Set<Section>()
  private rowSequence = 0
  private sourceRenderGeneration = 0
  private sourceSaveState: "saved" | "saving" | "failed" = "saved"
  private pendingSourceReveal: string | null = null
  private sourceRevealTimer: number | null = null
  /**
   * One edit surface at a time. Opening a second row while the first was still
   * open left two inputs on screen and made the survivor depend on which blur
   * fired first; the field holds the current editor's own close action, so
   * nothing new is discarded when it runs.
   */
  private openEditor: (() => void) | null = null

  constructor(private options: StructuredSettingsOptions) {
    for (const section of ["sources", "filters", "redirects"] as const) {
      this.install(section)
      this.modes.set(section, "list")
    }
    this.flatEditors = new FlatSettingsEditors({
      onTouch: () => this.onTouch,
      closeOpenEditor: () => this.closeOpenEditor(),
      setOpenEditor: (close) => {
        this.openEditor = close
      },
      setDetail: (section) => this.detailSections.add(section),
      updateAddButton: (section) => this.updateAddButton(section),
      listActions: (section) => this.listActions(section),
      renderListStatus: (root, count, noun) =>
        this.renderListStatus(root, count, noun),
      rowBody: (...children) => this.rowBody(...children),
      rowChevron: (label, action) => this.rowChevron(label, action),
      render: (section) => this.render(section),
      root: (section) => this.roots.get(section),
      setText: (section, text) => {
        this.textarea(section).value = text
        this.baselines.set(section, text)
      },
      showForm: (root, title, fields, save, remove, presentation) =>
        this.showForm(
          root,
          title,
          fields,
          save,
          remove,
          undefined,
          presentation
        ),
      saveFilters: (values) => this.options.saveFilters(values),
      saveRedirects: (values) => this.options.saveRedirects(values)
    })
  }

  /**
   * Touch platforms replace the footer action bar with a floating add button
   * and the paired group buttons with an anchored menu. Desktop and the
   * extensions keep the footer, so the two presentations must not both render
   * the same test ids.
   */
  private get onTouch(): boolean {
    return document.body.dataset.platform === "mobile"
  }

  /** The tab bar is fixed to the bottom; menus must never open behind it. */
  private bottomInset(): number {
    if (!this.onTouch) return 0
    const menu = document.querySelector<HTMLElement>("#menu")
    return menu ? Math.round(menu.getBoundingClientRect().height) : 0
  }

  private openMenu(anchor: HTMLElement, items: AnchoredMenuItem[]): void {
    openAnchoredMenu({
      anchor,
      items,
      bottomInset: this.bottomInset()
    })
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
    // Every list gets the footer: it is where the desktop reference puts the
    // count ("12 keywords", "3 rules") and the save state. It hides itself in
    // text mode through the .structured_settings[hidden] + … adjacency.
    const status = document.createElement("div")
    status.className = "structured_status_strip"
    status.innerHTML =
      '<span class="structured_status_counts"></span>' +
      '<span class="structured_status_saved" role="status"></span>'
    root.after(status)
    installDragAutoScroll(root)
    const listActions = document.createElement("div")
    listActions.className = "structured_list_actions"
    listActions.dataset.structuredActions = section
    actions.classList.add(`structured_actions_${section}`)
    actions.prepend(listActions)
    input.hidden = true
    actions.classList.add("structured_text_actions")
    if (this.onTouch) this.installAddButton(section, block, root)
    this.updateActionVisibility(section)
  }

  /**
   * The floating +. It replaces the footer bar on touch, so it carries the
   * footer's test id and the footer's buttons are never rendered there.
   */
  private installAddButton(
    section: Section,
    block: HTMLElement,
    root: HTMLElement
  ): void {
    const labels: Record<Section, string> = {
      sources: "Add source",
      filters: "Add filter",
      redirects: "Add redirect"
    }
    const testids: Record<Section, string> = {
      sources: "add-source",
      filters: "add-filter",
      redirects: "add-redirect"
    }
    const button = document.createElement("button")
    button.type = "button"
    button.className = "structured_add_button"
    button.dataset.testid = testids[section]
    button.title = labels[section]
    button.setAttribute("aria-label", labels[section])
    const glyph = document.createElement("span")
    glyph.className = "structured_add_glyph"
    glyph.setAttribute("aria-hidden", "true")
    glyph.textContent = "+"
    button.append(glyph)
    button.addEventListener("click", () => {
      if (section === "filters") {
        this.flatEditors.editFilter(root)
        return
      }
      if (section === "redirects") {
        this.flatEditors.editRedirect(root)
        return
      }
      this.openMenu(button, this.addSourceMenu(root))
    })
    ;(block.closest<HTMLElement>(".settings_section") || block).append(button)
    this.addButtons.set(section, button)
  }

  private addSourceMenu(root: HTMLElement): AnchoredMenuItem[] {
    const items: AnchoredMenuItem[] = [
      {
        id: "add-source-entry",
        label: "Source",
        testid: "add-source-entry",
        select: () => this.editSource(root)
      },
      {
        id: "add-group",
        label: "Group",
        testid: "add-group",
        select: () => this.editGroup(root)
      }
    ]
    // The picker is unavailable where the host cannot reach a page to pick
    // from; mountOnceUi hides its button there.
    const picker = document.querySelector<HTMLElement>("#pick_source_button")
    if (picker && !picker.hidden) {
      items.push({
        id: "pick-source-page",
        label: "Pick from page",
        testid: "pick-source-page",
        select: () => picker.click()
      })
    }
    return items
  }

  /** Hides the floating + whenever the list is not the visible surface. */
  private updateAddButton(section: Section): void {
    const button = this.addButtons.get(section)
    if (!button) return
    button.hidden = this.modes.get(section) !== "list" ||
      this.detailSections.has(section)
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
      // Nothing left to show: collapse the bar rather than leave its band of
      // padding under the list.
      actions.classList.toggle(
        "structured_actions_empty",
        this.onTouch && mode === "list"
      )
      for (const child of Array.from(actions.children)) {
        const element = child as HTMLElement
        // On touch the floating + owns adding and the whole bar is collapsed,
        // so per-child hiding is left alone — `hidden` on the picker button
        // stays the host's own "no page to pick from" signal.
        if (this.onTouch && mode === "list") continue
        const isPicker = element.id === "pick_source_button" ||
          element.id === "pick_source_status"
        const isListActions = element.dataset.structuredActions === section
        element.hidden = mode === "list"
          ? !isPicker && !isListActions
          : isListActions
      }
    }
    this.placeDesktopActions(section)
    this.updateAddButton(section)
    this.placePickerStatus(section)
  }

  /**
   * Without the footer the picker has nowhere to report from, so its status
   * line moves under the search field. It is the same element SourcePickerView
   * writes to, only re-parented.
   */
  private placePickerStatus(section: Section): void {
    if (section !== "sources" || !this.onTouch) return
    // Cached: rendering the list detaches the element from the search row, and
    // a detached node is no longer reachable by id.
    const status = this.pickerStatus ||
      document.getElementById("pick_source_status")
    if (!status) return
    this.pickerStatus = status
    const root = this.roots.get("sources")
    const listMode = this.modes.get("sources") === "list"
    if (listMode && root) {
      status.classList.add("structured_picker_status")
      const search = root.querySelector<HTMLElement>(".structured_search")
      if (search) search.after(status)
      return
    }
    status.classList.remove("structured_picker_status")
    const actions = this.textarea("sources")
      .closest<HTMLElement>(".settings_editor_block")
      ?.querySelector<HTMLElement>(".settings_actions")
    if (actions && status.parentElement !== actions) actions.append(status)
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
    if (section === "filters") this.flatEditors.readFilters(text)
    if (section === "redirects") this.flatEditors.readRedirects(text)
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
    this.pendingSourceReveal = source.trim()
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
      this.pendingSourceReveal = null
      announceStructuredSettings("That story source is no longer in settings.")
      return true
    }
    this.sourceGroupOpen.set(this.sourceGroups[groupIndex].id, true)
    this.applyPendingSourceReveal()
    return true
  }

  private applyPendingSourceReveal(): void {
    const source = this.pendingSourceReveal
    if (!source) return
    if (this.sourceRevealTimer !== null) {
      window.clearTimeout(this.sourceRevealTimer)
      this.sourceRevealTimer = null
    }
    requestAnimationFrame(() => {
      if (this.pendingSourceReveal !== source) return
      const root = this.roots.get("sources")
      const target = Array.from(root?.querySelectorAll<HTMLButtonElement>(
        "[data-source-value]"
      ) || []).find((button) => button.dataset.sourceValue === source)
      const details = target?.closest<HTMLDetailsElement>(".structured_group")
      if (!target || !details) return
      details.open = true
      target.focus({ preventScroll: true })
      target.scrollIntoView({ block: "center" })
      target.classList.add("structured_row_target")
      this.sourceRevealTimer = window.setTimeout(() => {
        if (this.pendingSourceReveal !== source) return
        this.pendingSourceReveal = null
        this.sourceRevealTimer = null
        const current = Array.from(
          this.roots.get("sources")?.querySelectorAll<HTMLButtonElement>(
            "[data-source-value]"
          ) || []
        ).find((button) => button.dataset.sourceValue === source)
        current?.classList.remove("structured_row_target")
      }, 1600)
    })
  }

  focusFilter(filter: string): boolean {
    if (this.isTextMode("filters")) return false
    return this.flatEditors.focusFilter(filter)
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
      this.flatEditors.editFilterAt(root, rowIndex)
    } else {
      this.flatEditors.editRedirect(root, rowIndex)
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

  /**
   * Close whatever edit surface is open. Each editor registers its own close
   * action, which is that editor's ordinary exit — so this commits or reverts
   * exactly as clicking away from it would, and can never fail and leave two
   * editors on screen.
   */
  private closeOpenEditor(): void {
    const close = this.openEditor
    this.openEditor = null
    close?.()
  }

  private render(section: Section): void {
    const root = this.roots.get(section)
    if (!root) return
    this.preserveDesktopActions(section, root)
    this.detailSections.delete(section)
    // Rebuilding the list destroys any editor inside it, so the registered
    // close action would only run against detached nodes.
    this.openEditor = null
    this.options.setDetailTitle?.(null)
    root.textContent = ""
    renderStructuredSearch(root, section, this.searchQueries)
    if (section === "sources") {
      this.renderSources(root)
      this.applyPendingSourceReveal()
    }
    if (section === "filters") this.flatEditors.renderFilters(root)
    if (section === "redirects") this.flatEditors.renderRedirects(root)
    applyStructuredSearch(root, section, this.searchQueries)
    this.placeDesktopActions(section)
    this.updateAddButton(section)
    this.placePickerStatus(section)
  }

  private preserveDesktopActions(section: Section, root: HTMLElement): void {
    if (this.onTouch) return
    const actions = this.textarea(section)
      .closest<HTMLElement>(".settings_editor_block")
      ?.querySelector<HTMLElement>(".settings_actions")
    const listActions = root.querySelector<HTMLElement>(
      `[data-structured-actions="${section}"]`
    )
    if (actions && listActions) actions.prepend(listActions)
    if (actions && section === "sources") {
      const picker = root.querySelector<HTMLElement>("#pick_source_button")
      if (picker) actions.append(picker)
    }
  }

  private placeDesktopActions(section: Section): void {
    if (this.onTouch) return
    const root = this.roots.get(section)
    const actions = this.textarea(section)
      .closest<HTMLElement>(".settings_editor_block")
      ?.querySelector<HTMLElement>(".settings_actions")
    const listActions = document.querySelector<HTMLElement>(
      `[data-structured-actions="${section}"]`
    )
    if (!root || !actions || !listActions) return
    if (this.modes.get(section) === "list") {
      listActions.hidden = false
      root.querySelector<HTMLElement>(".structured_search")?.append(listActions)
      if (section === "sources") {
        const picker = document.getElementById("pick_source_button")
        if (picker) root.querySelector(".structured_search")?.append(picker)
      }
      actions.classList.add("structured_desktop_actions_empty")
    } else {
      actions.classList.remove("structured_desktop_actions_empty")
      listActions.hidden = true
      actions.prepend(listActions)
      if (section === "sources") {
        const picker = document.getElementById("pick_source_button")
        if (picker) actions.append(picker)
      }
    }
  }

  private renderSources(root: HTMLElement): void {
    const renderGeneration = ++this.sourceRenderGeneration
    const toolbar = this.listActions("sources")
    if (!this.onTouch) {
      toolbar?.append(
        createActionButton("Add source", () => this.editSource(root), "add-source"),
        createActionButton("Add group", () => this.editGroup(root), "add-source-group")
      )
    }
    const sourceCount = this.sourceGroups.reduce(
      (count, group) => count + group.sources.length,
      0
    )
    const failing = this.sourceGroups.reduce((count, group) =>
      count + group.sources.filter((source) => this.errors.has(source.trim())).length,
    0)
    const status = root.parentElement?.querySelector<HTMLElement>(
      ".structured_status_counts"
    )
    if (status) {
      status.textContent =
        `${sourceCount} ${sourceCount === 1 ? "source" : "sources"} · ` +
        `${this.sourceGroups.length} ${this.sourceGroups.length === 1 ? "group" : "groups"}`
      if (failing) {
        const issue = document.createElement("span")
        issue.className = "structured_status_error"
        issue.textContent = ` ${failing} failing`
        status.append(issue)
      }
    }
    this.renderSourceSaveState(root)

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
    const beginGroupDrag = (
      groupIndex: number,
      details: HTMLElement,
      summary: HTMLElement
    ) => {
      if (groupIndex === 0 || draggedGroupIndex !== null) return false
      draggedGroupIndex = groupIndex
      pendingGroupDestination = null
      groupDropCommitted = false
      suppressGroupToggle = true
      expandedSnapshot = new Map(
        Array.from(root.querySelectorAll<HTMLDetailsElement>(
          ".structured_group"
        )).map((entry) => [
          entry.dataset.groupId || "",
          entry.open
        ])
      )
      details.classList.add("structured_group_dragging")
      const startingTop = summary.getBoundingClientRect().top
      collapseFrame = requestAnimationFrame(() => {
        collapseFrame = null
        if (draggedGroupIndex !== groupIndex) return
        root.classList.add("structured_group_drag_active")
        const movedBy = summary.getBoundingClientRect().top - startingTop
        if (movedBy) root.scrollTop += movedBy
      })
      return true
    }
    const updateGroupDestination = (
      details: HTMLElement,
      groupIndex: number,
      clientY: number
    ) => {
      if (draggedGroupIndex === null) return
      clearDropTargets()
      const bounds = details.getBoundingClientRect()
      const after = groupIndex > 0 &&
        clientY >= bounds.top + bounds.height / 2
      const dropAfter = groupIndex === 0 || after
      let destination = groupIndex === 0
        ? 1
        : groupIndex + (dropAfter ? 1 : 0)
      if (draggedGroupIndex < destination) destination--
      pendingGroupDestination = Math.max(
        1,
        Math.min(destination, this.sourceGroups.length - 1)
      )
      details.classList.add(
        dropAfter
          ? "structured_group_drop_after"
          : "structured_group_drop_before"
      )
    }
    const updateGroupDestinationAt = (clientY: number) => {
      if (draggedGroupIndex === null || clientY <= 0) return false
      const groups = Array.from(
        root.querySelectorAll<HTMLElement>(".structured_group")
      )
      if (!groups.length) return false
      const target = groups.find((candidate) => {
        const bounds = candidate.getBoundingClientRect()
        return clientY >= bounds.top && clientY <= bounds.bottom
      }) || groups.reduce((closest, candidate) => {
        const closestBounds = closest.getBoundingClientRect()
        const candidateBounds = candidate.getBoundingClientRect()
        const closestDistance = Math.min(
          Math.abs(clientY - closestBounds.top),
          Math.abs(clientY - closestBounds.bottom)
        )
        const candidateDistance = Math.min(
          Math.abs(clientY - candidateBounds.top),
          Math.abs(clientY - candidateBounds.bottom)
        )
        return candidateDistance < closestDistance ? candidate : closest
      })
      const groupIndex = Number(target.dataset.groupIndex)
      if (!Number.isInteger(groupIndex)) return false
      updateGroupDestination(target, groupIndex, clientY)
      return true
    }
    root.addEventListener("dragover", (event) => {
      if (!updateGroupDestinationAt(event.clientY)) return
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    })
    root.addEventListener("drop", (event) => {
      if (draggedGroupIndex === null || pendingGroupDestination === null) return
      event.preventDefault()
      commitGroupDrop(pendingGroupDestination)
    })

    this.sourceGroups.forEach((group, groupIndex) => {
      const details = document.createElement("details")
      details.className = "structured_group"
      if (groupIndex > 0) details.classList.add("structured_group_reorderable")
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
      const caret = document.createElement("span")
      caret.className = "structured_group_caret"
      caret.setAttribute("aria-hidden", "true")
      const dragHandle = document.createElement("span")
      dragHandle.className = "structured_group_drag_handle"
      dragHandle.setAttribute("aria-hidden", "true")
      const name = document.createElement("strong")
      name.className = "structured_group_name"
      name.textContent = group.name
      name.dataset.searchText = group.name
      name.draggable = groupIndex > 0
      if (groupIndex > 0) {
        name.title = `Drag to reorder ${group.name}`
        name.setAttribute("aria-label", `${group.name} group; drag to reorder`)
      }
      const count = document.createElement("span")
      count.className = "structured_group_count"
      count.textContent = String(group.sources.length)
      summary.append(caret)
      if (groupIndex > 0) summary.append(dragHandle)
      summary.append(name, count)
      if (groupIndex === 0) {
        const menuSpacer = document.createElement("span")
        menuSpacer.className = "structured_group_menu_spacer"
        menuSpacer.setAttribute("aria-hidden", "true")
        summary.append(menuSpacer)
      }
      if (groupIndex > 0) {
        const controls = document.createElement("span")
        controls.className = "structured_group_actions"
        controls.addEventListener("click", (event) => event.preventDefault())
        const menuButton = document.createElement("button")
        menuButton.type = "button"
        menuButton.className = "structured_group_menu"
        menuButton.textContent = "⋮"
        menuButton.title = `${group.name} group actions`
        menuButton.setAttribute("aria-label", menuButton.title)
        menuButton.addEventListener("click", () => {
          this.openMenu(menuButton, [
            {
              id: "rename-group",
              label: "Rename group",
              testid: "rename-source-group",
              select: () => this.editGroup(root, groupIndex)
            },
            {
              id: "delete-group",
              label: "Delete group",
              testid: "delete-source-group",
              select: () => this.deleteGroup(root, groupIndex)
            },
            {
              id: "add-source-here",
              label: "Add source here",
              // Desktop keeps this id on its footer "Add group" button.
              testid: this.onTouch ? "add-source-group" : "add-source-here",
              select: () => this.editSource(root, groupIndex)
            }
          ])
        })
        controls.append(menuButton)
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
        suppressNextSummaryClick = true
        beginGroupDrag(groupIndex, details, summary)
        event.dataTransfer?.setData(
          "application/x-once-source-group",
          String(groupIndex)
        )
        event.dataTransfer?.setData("text/plain", `group:${groupIndex}`)
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"
      })
      name.addEventListener("drag", (event) => {
        updateGroupDestinationAt(event.clientY)
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
        updateGroupDestination(details, groupIndex, event.clientY)
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
      if (this.onTouch && groupIndex > 0) {
        const holdDelay = 320
        let pointerId: number | null = null
        let pointerStartY = 0
        let pointerLastY = 0
        let pointerGrabOffset = 0
        let dragBaseTop = 0
        let pointerDragging = false
        let holdTimer: number | null = null
        const clearHold = () => {
          if (holdTimer !== null) window.clearTimeout(holdTimer)
          holdTimer = null
          details.classList.remove("structured_group_pressing")
        }
        const targetAt = (clientY: number) => {
          const candidates = Array.from(
            root.querySelectorAll<HTMLElement>(".structured_group")
          ).filter((candidate) => candidate !== details)
          return candidates.reduce<HTMLElement | null>((nearest, candidate) => {
            const bounds = candidate.getBoundingClientRect()
            if (clientY >= bounds.top && clientY <= bounds.bottom) {
              return candidate
            }
            if (!nearest) return candidate
            const nearestBounds = nearest.getBoundingClientRect()
            const distance = Math.min(
              Math.abs(clientY - bounds.top),
              Math.abs(clientY - bounds.bottom)
            )
            const nearestDistance = Math.min(
              Math.abs(clientY - nearestBounds.top),
              Math.abs(clientY - nearestBounds.bottom)
            )
            return distance < nearestDistance ? candidate : nearest
          }, null)
        }
        const activatePointerDrag = () => {
          holdTimer = null
          details.classList.remove("structured_group_pressing")
          suppressNextSummaryClick = true
          pointerDragging = beginGroupDrag(groupIndex, details, summary)
          if (!pointerDragging) return
          const positionDraggedGroup = () => {
            const offset = pointerLastY - pointerGrabOffset - dragBaseTop
            details.style.setProperty(
              "--structured-group-drag-y",
              `${offset}px`
            )
          }
          dragBaseTop = details.getBoundingClientRect().top
          positionDraggedGroup()
          // beginGroupDrag collapses every card on the next frame. Rebase once
          // that layout change has happened so the held point stays exactly
          // under the finger instead of jumping with the collapsed rows.
          requestAnimationFrame(() => {
            if (!pointerDragging) return
            const transform = Number.parseFloat(
              details.style.getPropertyValue("--structured-group-drag-y")
            ) || 0
            dragBaseTop = details.getBoundingClientRect().top - transform
            positionDraggedGroup()
          })
          const neighbor = root.querySelector<HTMLElement>(
            `.structured_group[data-group-index="${groupIndex + 1}"]`
          ) || root.querySelector<HTMLElement>(
            `.structured_group[data-group-index="${groupIndex - 1}"]`
          )
          if (neighbor) {
            const neighborIndex = Number(neighbor.dataset.groupIndex)
            const bounds = neighbor.getBoundingClientRect()
            updateGroupDestination(
              neighbor,
              neighborIndex,
              groupIndex < neighborIndex ? bounds.top : bounds.bottom
            )
          }
        }
        const finishPointerDrag = (commit: boolean) => {
          if (pointerId === null) return
          clearHold()
          const draggedId = group.id
          if (pointerDragging && commit &&
              pendingGroupDestination !== null) {
            commitGroupDrop(pendingGroupDestination)
          } else {
            restoreExpandedState()
            revealGroup(draggedId)
          }
          details.classList.remove("structured_group_dragging")
          details.style.removeProperty("--structured-group-drag-y")
          pointerId = null
          pointerDragging = false
          pendingGroupDestination = null
          window.setTimeout(() => {
            suppressNextSummaryClick = false
          }, 0)
        }
        const beginTouch = (
          identifier: number,
          clientY: number,
          target: EventTarget | null
        ) => {
          if (target instanceof Element &&
              target.closest(".structured_group_menu")) return
          pointerId = identifier
          pointerStartY = clientY
          pointerLastY = clientY
          pointerGrabOffset = clientY - details.getBoundingClientRect().top
          pointerDragging = false
          holdTimer = window.setTimeout(activatePointerDrag, holdDelay)
        }
        const moveTouch = (identifier: number, clientY: number) => {
          if (identifier !== pointerId) return false
          pointerLastY = clientY
          if (!pointerDragging) {
            if (Math.abs(clientY - pointerStartY) < 8) return false
            clearHold()
            pointerId = null
            return false
          }
          details.style.setProperty("--structured-group-drag-y",
            `${pointerLastY - pointerGrabOffset - dragBaseTop}px`)
          const target = targetAt(clientY)
          if (!target) return true
          const targetIndex = Number(target.dataset.groupIndex)
          if (!Number.isInteger(targetIndex)) return true
          updateGroupDestination(target, targetIndex, clientY)
          return true
        }
        summary.addEventListener("touchstart", (event) => {
          if (event.touches.length !== 1) return
          const touch = event.changedTouches[0]
          beginTouch(touch.identifier, touch.clientY, event.target)
        }, { passive: true })
        summary.addEventListener("touchmove", (event) => {
          const touch = Array.from(event.changedTouches).find(
            (entry) => entry.identifier === pointerId
          )
          if (!touch) return
          if (moveTouch(touch.identifier, touch.clientY)) {
            // No movement happened during the hold, so native scrolling has
            // not begun. From activation onward this gesture belongs to the
            // reorder interaction and must stay with it.
            event.preventDefault()
          }
        }, { passive: false })
        summary.addEventListener("touchend", (event) => {
          const touch = Array.from(event.changedTouches).find(
            (entry) => entry.identifier === pointerId
          )
          if (!touch) return
          finishPointerDrag(true)
        })
        summary.addEventListener("touchcancel", (event) => {
          const touch = Array.from(event.changedTouches).find(
            (entry) => entry.identifier === pointerId
          )
          if (!touch) return
          finishPointerDrag(false)
        })
        summary.addEventListener("pointerdown", (event) => {
          if (event.pointerType === "mouse" ||
              event.pointerType === "touch" ||
              event.button !== 0) return
          if ((event.target as Element).closest(".structured_group_menu")) return
          pointerId = event.pointerId
          pointerStartY = event.clientY
          pointerLastY = event.clientY
          pointerGrabOffset = event.clientY -
            details.getBoundingClientRect().top
          pointerDragging = false
          holdTimer = window.setTimeout(activatePointerDrag, holdDelay)
          try {
            summary.setPointerCapture(event.pointerId)
          } catch {
            // Synthetic test events and older WebViews may not expose capture.
          }
        })
        summary.addEventListener("pointermove", (event) => {
          if (event.pointerId !== pointerId) return
          pointerLastY = event.clientY
          if (!pointerDragging) {
            if (Math.abs(event.clientY - pointerStartY) < 8) return
            clearHold()
            pointerId = null
            return
          }
          event.preventDefault()
          details.style.setProperty("--structured-group-drag-y",
            `${pointerLastY - pointerGrabOffset - dragBaseTop}px`)
          const target = targetAt(event.clientY)
          if (!target) return
          const targetIndex = Number(target.dataset.groupIndex)
          if (!Number.isInteger(targetIndex)) return
          updateGroupDestination(target, targetIndex, event.clientY)
        })
        summary.addEventListener("pointerup", (event) => {
          if (event.pointerId !== pointerId) return
          finishPointerDrag(true)
        })
        summary.addEventListener("pointercancel", (event) => {
          if (event.pointerId !== pointerId) return
          finishPointerDrag(false)
        })
      }
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

  /**
   * The text block of a row: everything right of the badge column. It carries
   * the separator, so the rule insets past the badge and the badges read as a
   * column. Nothing in here draws chrome of its own.
   */
  private rowBody(...children: HTMLElement[]): HTMLElement {
    const body = document.createElement("div")
    body.className = "structured_row_body"
    body.append(...children)
    return body
  }

  /** The only thing in a row that advertises the row itself is tappable. */
  private rowChevron(label?: string, action?: () => void): HTMLElement {
    const chevron = action
      ? document.createElement("button")
      : document.createElement("span")
    chevron.className = "structured_row_chevron"
    if (chevron instanceof HTMLButtonElement && action) {
      chevron.type = "button"
      chevron.title = label || "Edit"
      chevron.setAttribute("aria-label", chevron.title)
      chevron.addEventListener("click", action)
    } else {
      chevron.setAttribute("aria-hidden", "true")
    }
    return chevron
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
    const dragHandle = document.createElement("span")
    dragHandle.className = "structured_source_drag_handle"
    dragHandle.setAttribute("aria-hidden", "true")
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
    const error = this.errors.get(source.trim())
    // A failing source says why here, in its short title — the full sentence
    // does not fit one line and ellipsises to nothing useful. The whole message
    // is a tap away on the issue button, and the URL stays in the row's title.
    secondary.textContent = error ? error.title || error.message : source
    secondary.dataset.searchText = secondary.textContent
    if (error) secondary.classList.add("structured_row_secondary_error")
    open.append(primary, secondary)
    open.addEventListener("click", () =>
      this.editSource(root, groupIndex, sourceIndex))
    const body = this.rowBody(open)
    if (error) {
      row.classList.add(`structured_row_${error.type}`)
      const issue = createActionButton(
        error.type === "warning" ? "⚠" : "!",
        () => this.options.showSourceError(source),
        "source-error"
      )
      issue.className = `structured_issue ${error.type}`
      issue.title = `Open ${error.type} details`
      body.append(issue)
    }
    body.append(this.rowChevron(`Edit ${source}`, () =>
      this.editSource(root, groupIndex, sourceIndex)))
    if (!this.onTouch) {
      const menuButton = document.createElement("button")
      menuButton.type = "button"
      menuButton.className = "structured_row_menu"
      menuButton.textContent = "⋮"
      menuButton.title = `Actions for ${source}`
      menuButton.setAttribute("aria-label", menuButton.title)
      const openRowMenu = () => this.openMenu(menuButton, [
        {
          id: "edit-source",
          label: "Edit source",
          select: () => this.editSource(root, groupIndex, sourceIndex)
        },
        {
          id: "delete-source",
          label: "Delete source",
          select: () => {
            if (!window.confirm("Delete this story source?")) return
            this.sourceGroups[groupIndex].sources.splice(sourceIndex, 1)
            this.saveSources()
          }
        }
      ])
      menuButton.addEventListener("click", openRowMenu)
      body.append(menuButton)
      row.addEventListener("contextmenu", (event) => {
        event.preventDefault()
        openRowMenu()
      })
    }
    row.append(dragHandle, badge, body)
    const clearSourceDropTargets = () => {
      root.querySelectorAll(
        ".structured_source_drop_before, .structured_source_drop_after"
      ).forEach((target) => target.classList.remove(
        "structured_source_drop_before",
        "structured_source_drop_after"
      ))
      root.querySelectorAll(
        ".structured_source_group_drop_target," +
        " .structured_source_group_title_drop_target"
      ).forEach((target) => target.classList.remove(
        "structured_source_group_drop_target",
        "structured_source_group_title_drop_target"
      ))
    }
    const updateSourceDropTarget = (clientY: number) => {
      if (clientY <= 0) return
      clearSourceDropTargets()
      const candidates = Array.from(
        root.querySelectorAll<HTMLElement>(".structured_row")
      ).filter((candidate) =>
        candidate !== row && candidate.offsetParent !== null)
      const target = candidates.find((candidate) => {
        const bounds = candidate.getBoundingClientRect()
        return clientY >= bounds.top && clientY <= bounds.bottom
      })
      if (target) {
        const bounds = target.getBoundingClientRect()
        target.classList.add(clientY >= bounds.top + bounds.height / 2
          ? "structured_source_drop_after"
          : "structured_source_drop_before")
        return
      }
      const groups = Array.from(
        root.querySelectorAll<HTMLElement>(".structured_group")
      )
      const targetGroup = groups.find((candidate) => {
        const bounds = candidate.getBoundingClientRect()
        return clientY >= bounds.top && clientY <= bounds.bottom
      })
      if (!targetGroup) return
      const list = targetGroup.querySelector<HTMLElement>(".structured_rows")
      if (list && list.offsetParent !== null) {
        list.classList.add("structured_source_group_drop_target")
      } else {
        targetGroup.classList.add("structured_source_group_title_drop_target")
      }
    }
    row.addEventListener("dragstart", (event) => {
      row.classList.add("structured_row_dragging")
      event.dataTransfer?.setData("text/plain", `${groupIndex}:${sourceIndex}`)
    })
    // Android WebView reports the pointer position on the drag source but may
    // omit dragover on the element underneath it. Resolve the visual target
    // from those coordinates so mobile gets the same insertion feedback.
    row.addEventListener("drag", (event) => {
      updateSourceDropTarget(event.clientY)
    })
    row.addEventListener("dragend", () => {
      row.classList.remove("structured_row_dragging")
      clearSourceDropTargets()
    })
    row.addEventListener("dragover", (event) => {
      if (!this.sourceDragPosition(event.dataTransfer)) return
      event.preventDefault()
      event.stopPropagation()
      clearSourceDropTargets()
      const bounds = row.getBoundingClientRect()
      row.classList.add(event.clientY >= bounds.top + bounds.height / 2
        ? "structured_source_drop_after"
        : "structured_source_drop_before")
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move"
    })
    row.addEventListener("dragleave", (event) => {
      const next = event.relatedTarget
      if (next instanceof Node && row.contains(next)) return
      row.classList.remove(
        "structured_source_drop_before",
        "structured_source_drop_after"
      )
    })
    row.addEventListener("drop", (event) => {
      event.preventDefault()
      event.stopPropagation()
      const bounds = row.getBoundingClientRect()
      const after = event.clientY >= bounds.top + bounds.height / 2
      row.classList.remove(
        "structured_source_drop_before",
        "structured_source_drop_after"
      )
      const position = this.sourceDragPosition(event.dataTransfer)
      if (position) {
        const [fromGroup, fromIndex] = position
        const [value] = this.sourceGroups[fromGroup].sources.splice(fromIndex, 1)
        let destination = sourceIndex + (after ? 1 : 0)
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
    }, sourceIndex === undefined ? undefined : {
      label: "Delete source",
      action: () => {
        if (!window.confirm("Delete this story source?")) return
        this.sourceGroups[groupIndex].sources.splice(sourceIndex, 1)
        this.saveSources()
      }
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
    this.preserveDesktopActions("sources", root)
    this.listActions("sources")
    root.textContent = ""
    this.detailSections.add("sources")
    this.updateAddButton("sources")
    const dialog = document.createElement("div")
    dialog.className = "structured_form"
    dialog.setAttribute("role", "dialog")
    const title = document.createElement("h3")
    title.textContent = `Delete “${group.name}”?`
    const explanation = document.createElement("p")
    explanation.textContent = "Choose what should happen to the sources in this group."
    dialog.append(title, explanation)
    const actions = document.createElement("div")
    actions.className = "structured_form_actions"
    actions.append(
      createActionButton("Remove group and move sources to Default", () => {
        this.sourceGroups[0].sources.push(...group.sources)
        this.sourceGroups.splice(groupIndex, 1)
        this.saveSources()
      }),
      createActionButton("Remove group and its sources", () => {
        if (!window.confirm(`Permanently delete ${group.sources.length} sources?`)) return
        this.sourceGroups.splice(groupIndex, 1)
        this.saveSources()
      }),
      createActionButton("Cancel", () => this.render("sources")))
    dialog.append(actions)
    root.append(dialog)
  }

  private saveSources(reloadStories = true): void {
    const values = serializeSourceGroups(this.sourceGroups)
    this.textarea("sources").value = values.join("\n")
    this.baselines.set("sources", this.textarea("sources").value)
    this.sourceSaveState = "saving"
    this.render("sources")
    Promise.resolve(this.options.saveSources(values, reloadStories)).then(
      () => {
        this.sourceSaveState = "saved"
        this.renderSourceSaveState(this.roots.get("sources"))
      },
      () => {
        this.sourceSaveState = "failed"
        this.renderSourceSaveState(this.roots.get("sources"))
      }
    )
  }

  private renderSourceSaveState(root?: HTMLElement): void {
    const saved = root?.parentElement?.querySelector<HTMLElement>(
      ".structured_status_saved"
    )
    if (!saved) return
    saved.classList.toggle(
      "structured_status_error",
      this.sourceSaveState === "failed"
    )
    saved.textContent = this.sourceSaveState === "saving"
      ? "Saving…"
      : this.sourceSaveState === "failed" ? "Save failed" : "Saved"
  }

  /**
   * Footer counts for the flat lists. Sources track a real asynchronous save
   * state; filters and redirects are written on every edit, so their half of
   * the strip simply says so.
   */
  private renderListStatus(root: HTMLElement, count: number, noun: string): void {
    const strip = root.parentElement
    const counts = strip?.querySelector<HTMLElement>(
      ".structured_status_counts"
    )
    if (counts) {
      counts.textContent = `${count} ${count === 1 ? noun : `${noun}s`}`
    }
    const saved = strip?.querySelector<HTMLElement>(".structured_status_saved")
    if (saved) saved.textContent = "Saved"
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
    fields: Array<[
      string,
      string,
      { multiline?: boolean; hint?: string }?
    ]>,
    save: (values: string[]) => boolean,
    /** Labelled because the word is the only thing separating it from cancel. */
    remove?: { label: string; action: () => void },
    choices?: Array<[string, string]>,
    presentation?: {
      host?: HTMLElement
      redirectTester?: boolean
    }
  ): void {
    const section = root.dataset.structuredSection as Section
    this.detailSections.add(section)
    this.updateAddButton(section)
    this.preserveDesktopActions(section, root)
    this.listActions(section)
    if (!presentation?.host) root.textContent = ""
    const form = document.createElement("form")
    form.className = "structured_form"
    if (presentation?.redirectTester) {
      form.classList.add("structured_redirect_form")
    }
    form.dataset.testid = "structured-item-form"
    const title = document.createElement("h3")
    title.textContent = titleText
    form.append(title)
    const inputs: FormField[] = []
    fields.forEach(([labelText, value, fieldOptions], fieldIndex) => {
      const label = document.createElement("label")
      label.className = "structured_form_field"
      const labelName = document.createElement("span")
      labelName.className = "structured_form_label"
      labelName.textContent = labelText
      label.append(labelName)
      let input: FormField
      if (choices && fieldIndex === fields.length - 1) {
        input = document.createElement("select")
        choices.forEach(([choiceValue, choiceLabel]) => {
          const option = document.createElement("option")
          option.value = choiceValue
          option.textContent = choiceLabel
          input.append(option)
        })
      } else if (fieldOptions?.multiline) {
        input = document.createElement("textarea")
        input.rows = this.onTouch && fieldIndex === 0 ? 3 : 2
      } else {
        input = document.createElement("input")
        input.type = "text"
      }
      input.value = value
      input.required = true
      label.append(input)
      if (fieldOptions?.hint) {
        const hint = document.createElement("span")
        hint.className = "structured_form_hint"
        hint.textContent = fieldOptions.hint
        label.append(hint)
      }
      inputs.push(input)
      form.append(label)
    })
    const tester = presentation?.redirectTester
      ? createRedirectTester(
        inputs[0],
        inputs[1],
        this.options.loadedStoryUrls?.() || []
      )
      : undefined
    if (tester) form.append(tester.element)
    const error = document.createElement("p")
    error.className = "structured_validation"
    error.setAttribute("role", "alert")
    const actions = document.createElement("div")
    actions.className = "structured_form_actions"
    const saveButton = createInlineActionButton("Save", () => {
      if (!form.reportValidity()) return
      if (!save(inputs.map((input) => input.value))) {
        error.textContent = "Complete all required fields."
      }
    }, "structured-save")
    const dismiss = () => {
      this.read(section)
      this.render(section)
    }
    const cancelButton = createInlineActionButton("Cancel", dismiss)
    this.openEditor = dismiss
    if (tester) {
      // Desktop shares the footer line between the corpus count and the commit
      // pair; the full-screen panel keeps it under the output block.
      if (this.onTouch) tester.element.append(tester.corpus)
      else actions.append(tester.corpus)
    }
    if (remove && this.onTouch) {
      // With no trailing column for a glyph to live in, the destructive action
      // can only be told from cancel by language. On desktop the row's own ×
      // already does this job, so the editor carries no delete button there.
      const deleteButton = createActionButton(
        remove.label,
        remove.action,
        "structured-delete"
      )
      deleteButton.className = "structured_form_delete"
      actions.append(deleteButton)
    }
    // Save then cancel, the same order as the inline filter row. The mobile
    // action bar assigns its own grid columns, so it is unaffected.
    actions.append(saveButton, cancelButton)
    form.addEventListener("submit", (event) => {
      event.preventDefault()
      actions.querySelector<HTMLButtonElement>("[data-testid='structured-save']")?.click()
    })
    form.append(error)
    form.append(actions)
    ;(presentation?.host || root).append(form)
    // On touch the form is a full-screen subpage, so its title belongs in the
    // header, where the back control is — not repeated inside the body.
    if (this.onTouch && !presentation?.host) {
      this.options.setDetailTitle?.(titleText)
    }
    tester?.refresh()
    inputs[0]?.focus()
  }

}
