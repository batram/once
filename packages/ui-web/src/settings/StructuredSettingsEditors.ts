import { SourceError } from "@once/app"
import { Redirect, StorySourceDocument } from "@once/core"
import { AnchoredMenuItem, openAnchoredMenu } from "../menu/storyAnchoredMenu"
import {
  applyStructuredSearch,
  renderStructuredSearch,
  StructuredSettingsSection
} from "./structured/structuredSearch"
import {
  announceStructuredSettings,
  FormField,
  showStructuredForm
} from "./structured/form"
import { createRedirectTester } from "./structured/redirectTester"
import { installDragAutoScroll } from "../gesture/dragReorder"
import { FlatSettingsEditors } from "./structured/FlatSettingsEditors"
import { SourceSettingsEditor } from "./structured/SourceSettingsEditor"
import { StructuredAddButtons } from "./structured/StructuredAddButtons"

export { parseFilterRows } from "./structured/filters"
export {
  parseRedirectRows,
  serializeRedirectRows
} from "./structured/redirects"
type Section = StructuredSettingsSection

export interface StructuredSettingsOptions {
  saveSources(values: StorySourceDocument, reloadStories?: boolean): void | Promise<void>
  /** A source's token, kept on this device; "" removes it. */
  saveSourceSecret(sourceId: string, secret: string): Promise<void>
  saveFilters(values: string[]): void
  saveRedirects(values: Redirect[]): void
  /** Refetches one source now, ignoring its cache window. */
  reloadSource(sourceId: string): void
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
  private sourceEditor: SourceSettingsEditor
  private flatEditors: FlatSettingsEditors
  private roots = new Map<Section, HTMLElement>()
  private headers = new Map<Section, HTMLElement>()
  private addButtons: StructuredAddButtons
  private pickerStatus: HTMLElement | null = null
  private toggles = new Map<Section, HTMLButtonElement>()
  private searchQueries = new Map<Section, string>()
  private detailSections = new Set<Section>()
  /**
   * One edit surface at a time. Opening a second row while the first was still
   * open left two inputs on screen and made the survivor depend on which blur
   * fired first; the field holds the current editor's own close action, so
   * nothing new is discarded when it runs.
   */
  private openEditor: (() => void) | null = null

  constructor(private options: StructuredSettingsOptions) {
    this.sourceEditor = new SourceSettingsEditor({
      onTouch: () => this.onTouch,
      getText: () => this.textarea("sources").value,
      setText: (text) => {
        this.textarea("sources").value = text
        this.baselines.set("sources", text)
      },
      render: () => this.render("sources"),
      root: () => this.roots.get("sources"),
      saveSources: (values, reload) => this.options.saveSources(values, reload),
      saveSourceSecret: (id, secret) => this.options.saveSourceSecret(id, secret),
      reloadSource: (id) => this.options.reloadSource(id),
      showSourceError: (source) => this.options.showSourceError(source),
      openMenu: (anchor, items) => this.openMenu(anchor, items),
      listActions: () => this.listActions("sources"),
      showForm: (root, title, fields, save, remove, choices, configure) =>
        this.showForm(root, title, fields, save, remove, choices, configure ? { configure } : undefined)
    })
    this.addButtons = new StructuredAddButtons({
      mode: (section) => this.modes.get(section) || "list",
      isDetail: (section) => this.detailSections.has(section),
      editSource: (root) => this.sourceEditor.editSource(root),
      editGroup: (root) => this.sourceEditor.editGroup(root),
      editFilter: (root) => this.flatEditors.editFilter(root),
      editRedirect: (root) => this.flatEditors.editRedirect(root),
      openMenu: (anchor, items) => this.openMenu(anchor, items)
    })
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
      enterFilterDetail: () => {
        this.detailSections.add("filters")
        this.updateAddButton("filters")
      },
      listActions: (section) => this.listActions(section),
      renderListStatus: (root, count, noun) =>
        this.renderListStatus(root, count, noun),
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
    if (!block || !input || !actions) return

    // Sits above the list and carries the mode toggle.
    const header = document.createElement("div")
    header.className = "structured_settings_header row"
    input.before(header)
    this.headers.set(section, header)
    const toggle = document.createElement("button")
    toggle.type = "button"
    toggle.className = "button structured_mode_toggle"
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
    listActions.className = "structured_list_actions row"
    listActions.dataset.structuredActions = section
    actions.classList.add(`structured_actions_${section}`)
    actions.prepend(listActions)
    input.hidden = true
    actions.classList.add("structured_text_actions")
    if (this.onTouch) this.addButtons.install(section, block, root)
    this.updateActionVisibility(section)
  }

  private updateAddButton(section: Section): void {
    this.addButtons.update(section)
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
    if (section === "sources") this.sourceEditor.read(text)
    if (section === "filters") this.flatEditors.readFilters(text)
    if (section === "redirects") this.flatEditors.readRedirects(text)
  }

  setErrors(errors: SourceError[]): void {
    this.sourceEditor.setErrors(errors)
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
    if (!this.sourceEditor.contains(source)) {
      announceStructuredSettings("That story source is no longer in settings.")
      return true
    }
    this.sourceEditor.reveal(source)
    return true
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
      try {
        const value = JSON.parse(lines[targetLine].trim().replace(/,$/, ""))
        if (typeof value?.id === "string" && value.id.startsWith("src_")) {
          const groupIndex = this.sourceEditor.groups.findIndex((group) =>
            group.sources.some((source) => source.id === value.id))
          const sourceIndex = this.sourceEditor.groups[groupIndex]?.sources
            .findIndex((source) => source.id === value.id)
          if (groupIndex >= 0 && sourceIndex >= 0) {
            this.sourceEditor.editSource(root, groupIndex, sourceIndex)
          }
        }
      } catch { /* envelope and group lines open no row editor */ }
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
      this.flatEditors.editRedirectAt(root, rowIndex)
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
    if (section === "sources") this.renderSources(root)
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
    this.sourceEditor.render(root)
    this.sourceEditor.applyReveal()
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
    fields: Array<[string, string, { multiline?: boolean; hint?: string }?]>,
    save: (values: string[]) => boolean | string,
    remove?: { label: string; action: () => void },
    choices?: Array<[string, string]>,
    presentation?: {
      host?: HTMLElement
      redirectTester?: boolean
      configure?: (inputs: FormField[], rows: HTMLElement) => void
    }
  ): void {
    const section = root.dataset.structuredSection as Section
    this.detailSections.add(section)
    this.updateAddButton(section)
    this.preserveDesktopActions(section, root)
    this.listActions(section)
    showStructuredForm({
      root,
      title: titleText,
      fields: choices && fields.length
        ? fields.map((field, index) => index === fields.length - 1
          ? [field[0], field[1], { ...field[2], kind: "select" as const, choices }]
          : field)
        : fields,
      save,
      remove,
      configure: presentation?.configure,
      host: presentation?.host,
      createTester: presentation?.redirectTester
        ? (inputs) => createRedirectTester(
          inputs[0],
          inputs[1],
          this.options.loadedStoryUrls?.() || []
        )
        : undefined,
      onTouch: this.onTouch,
      dismiss: () => { this.read(section); this.render(section) },
      setOpenEditor: (close) => { this.openEditor = close },
      setDetailTitle: (title) => this.options.setDetailTitle?.(title)
    })
  }

}
