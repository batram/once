import { OnceClient, SourceError } from "@once/app"
import { parseRedirectList, parseStorySourceText, presentRedirectList,
  serializeStorySourceDocument } from "@once/core"
import { requireClosestElement, requireElement } from "../dom"
import { revealElement } from "../scrollReveal"
import * as panelNavigation from "../shell/panelNavigation"
import { matchSettingsSection, SettingsSearchMatch } from "./settingsSearch"
import { SwipeSettingsLab } from "./SwipeSettingsLab"
import { StructuredSettingsEditors } from "./StructuredSettingsEditors"
import { SettingsPersistence } from "./SettingsPersistence"
import { updateSettingsSummaries } from "./settingsSummaries"
import { highlightTextareaContent, scrollTextareaSelectionIntoView } from "./textareaHighlight"
import * as settingsControls from "./settingsControlBindings"
import { bindSyncSettingsControls } from "./syncSettingsControls"
import { bindSettingsSubscriptions } from "./settingsSubscriptions"
import settingsSectionDefinitions from "./settingsSectionDefinitions"

export interface SettingsPanelOptions {
  /**
   * Last rung of the back chevron's chain, taken when the section index itself
   * is showing and there is nothing left inside Settings to close. A shell that
   * supplies one keeps the chevron visible on the index (mobile, where it is
   * the software twin of the hardware back key); a shell that does not leaves
   * the chevron hidden there and never reaches this.
   */
  exitSettings?: () => void
}

export class SettingsPanel {
  static instance: SettingsPanel
  readonly ready: Promise<void>
  private structuredEditors?: StructuredSettingsEditors
  private swipeLab?: SwipeSettingsLab
  private sourcesSaveChain = Promise.resolve()
  private sourcesReloadPending = false
  private persistence: SettingsPersistence

  constructor(
    private client: OnceClient,
    private options: SettingsPanelOptions = {}
  ) {
    this.persistence = new SettingsPersistence(
      client,
      () => this.refreshSettingsSearch()
    )
    SettingsPanel.instance = this
    bindSettingsSubscriptions(client, {
      filters: () => void this.set_filter_area(),
      redirects: () => void this.set_redirect_area(),
      sources: () => void this.set_sources_area(),
      theme: () => void this.restore_theme_settings(),
      animation: () => void this.restore_animation_settings(),
      cache: () => void this.restore_cache_settings(),
      sync: () => void this.reset_couch_settings(),
      swipe: () => this.swipeLab?.externalSettingsChanged(),
      sourceErrors: (errors) => this.setSourceErrors(errors),
      summaries: () => this.updateSettingsSummaries()
    })

    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", (e) => {
        console.debug("system theme change", e)
      })

    this.restore_theme_settings()

    this.restore_animation_settings()
    settingsControls.bindThemeAnimationControls(
      (theme) => this.save_theme(theme),
      (enabled) => this.save_animation(enabled)
    )

    bindSyncSettingsControls(
      () => this.reset_couch_settings(),
      () => this.save_couch_settings()
    )

    this.ready = this.set_sources_area()

    const sources_area = requireElement<HTMLTextAreaElement>("#sources_area")
    const sources_block = requireClosestElement<HTMLElement>(
      sources_area, ".settings_block")
    const saveSourcesButton = requireElement<HTMLButtonElement>(
      'button[data-action="save"]',
      sources_block
    )
    saveSourcesButton.addEventListener("click", async () => {
      saveSourcesButton.disabled = true
      try {
        await this.save_sources_settings()
      } finally {
        saveSourcesButton.disabled = false
      }
    })
    requireElement<HTMLButtonElement>('button[data-action="cancel"]', sources_block)
      .addEventListener("click", () => void this.set_sources_area())
    sources_area.addEventListener("keydown", (event) => {
      if (event.keyCode === 27) {
        void this.set_sources_area()
      } else if (event.key === "s" && event.ctrlKey) {
        void this.save_sources_settings()
      }
    })
    settingsControls.bindSourceTextarea(
      () => this.sourceErrors,
      (source) => this.showSourceErrorLog(source)
    )

    this.set_filter_area()

    settingsControls.bindTextSetting({
      textareaId: "filter_area",
      restore: () => this.set_filter_area(),
      save: () => this.save_filter_settings()
    })

    this.set_redirect_area()

    settingsControls.bindTextSetting({
      textareaId: "redirect_area",
      restore: () => this.set_redirect_area(),
      save: () => this.save_redirect_settings(),
      escape: () => this.set_filter_area()
    })

    this.swipeLab = new SwipeSettingsLab(
      requireElement<HTMLElement>("#swipe_lab"),
      this.client,
      () => {
        this.updateSettingsSummaries()
        this.refreshSettingsSearch()
      }
    )

    this.restore_cache_settings()
    settingsControls.bindCacheControls(
      () => this.restore_cache_settings(),
      () => this.save_cache_settings()
    )

    this.structuredEditors = this.createStructuredEditors()
    this.installSettingsNavigation()
  }

  private createStructuredEditors(): StructuredSettingsEditors {
    const editors = new StructuredSettingsEditors({
      saveSources: (values, reloadStories = true) => {
        this.sourcesSaveChain = this.sourcesSaveChain
          .catch((error) => {
            console.error("Failed to save an earlier story-source change", error)
          })
          .then(() => this.client.saveStorySources(values, reloadStories))
        if (reloadStories) {
          this.sourcesReloadPending = false
        } else {
          this.sourcesReloadPending = true
        }
        return this.sourcesSaveChain
      },
      saveFilters: (values) => this.client.saveFilterList(values),
      saveRedirects: (values) => this.client.saveRedirectList(values),
      showSourceError: (source) => this.showSourceErrorLog(source),
      setDetailTitle: (title) => this.setSettingsDetailTitle(title),
      loadedStoryUrls: () => this.client.getStorySnapshot().map(
        (story) => story.href
      )
    })
    editors.sync("sources")
    editors.sync("filters")
    editors.sync("redirects")
    return editors
  }

  private activeSettingsSection: string | null = null
  private settingsSectionButtons = new Map<string, HTMLButtonElement>()
  private settingsSections = new Map<string, HTMLElement>()
  private settingsSectionResults = new Map<string, HTMLElement>()
  private settingsSectionMatches = new Map<string, HTMLElement>()

  private installSettingsNavigation(): void {
    const index = requireElement<HTMLElement>("#settings_sections")
    const search = requireElement<HTMLInputElement>("#settings_search")
    const back = requireElement<HTMLButtonElement>("#settings_section_back")
    const noResults = document.createElement("p")
    noResults.id = "settings_search_empty"
    noResults.textContent = "No settings found"
    noResults.setAttribute("role", "status")
    noResults.setAttribute("aria-live", "polite")
    noResults.hidden = true

    for (const [key, label, selector] of settingsSectionDefinitions) {
      const control = requireElement<HTMLElement>(selector)
      const block = requireClosestElement<HTMLElement>(control, ".settings_block")
      // Platform-owned settings stay in the shared shell, but their platform
      // reveals them before SettingsPanel builds its navigation.
      if (block.hidden) continue
      const section = document.createElement("section")
      section.className = "settings_section"
      section.dataset.settingsSection = key
      section.setAttribute("aria-label", label)
      block.parentElement?.insertBefore(section, block)
      section.append(block)

      const result = document.createElement("div")
      result.className = "settings_section_result"
      const button = document.createElement("button")
      button.type = "button"
      button.className = "settings_section_row"
      button.dataset.settingsTarget = key
      button.dataset.settingsLabel = label
      const text = document.createElement("span")
      text.className = "settings_section_row_text"
      const title = document.createElement("span")
      title.textContent = label
      text.append(title)
      const summary = document.createElement("span")
      summary.className = "settings_section_summary"
      const arrow = document.createElement("span")
      arrow.className = "settings_section_arrow"
      arrow.setAttribute("aria-hidden", "true")
      arrow.textContent = "›"
      button.append(text, summary, arrow)
      button.onclick = () => this.openSettingsSection(key)
      const matches = document.createElement("div")
      matches.className = "settings_section_matches"
      matches.hidden = true
      result.append(button, matches)
      index.append(result)
      this.settingsSectionButtons.set(key, button)
      this.settingsSections.set(key, section)
      this.settingsSectionResults.set(key, result)
      this.settingsSectionMatches.set(key, matches)
    }
    index.append(noResults)

    search.addEventListener("input", () => {
      this.filterSettingsSections(search.value)
    })
    requireElement<HTMLElement>(".settings_container").addEventListener("input", (event) => {
      if (event.target !== search) {
        this.updateSettingsSummaries()
        this.filterSettingsSections(search.value)
      }
    })
    requireElement<HTMLElement>(".settings_container").addEventListener("change", () => {
      this.updateSettingsSummaries()
      this.filterSettingsSections(search.value)
    })
    new MutationObserver(() => {
      this.updateSettingsSummaries()
      this.filterSettingsSections(search.value)
    }).observe(requireElement<HTMLElement>("#error_log"), {
      childList: true,
      subtree: true,
      characterData: true
    })
    new MutationObserver(() => {
      this.updateSettingsSummaries()
    }).observe(index, {
      attributes: true,
      attributeFilter: ["data-error-count", "data-warning-count"],
      subtree: true
    })
    this.updateSettingsSummaries()
    // One chain, innermost first: a full-screen editor, then the open section,
    // then Settings itself. Visibility follows .settings_detail_open alone —
    // the button carries no `hidden` attribute, so no platform has to undo one
    // to keep the chevron live on the index.
    back.onclick = () => {
      if (this.structuredEditors?.handleBack(this.activeSettingsSection)) return
      if (this.activeSettingsSection) {
        this.closeSettingsSection()
        return
      }
      this.options.exitSettings?.()
    }
    document.addEventListener("once-settings-index-requested", () => {
      this.showSettingsIndex()
    })
    if (document.body.dataset.platform !== "mobile") {
      this.openSettingsSection("sources")
    }
  }

  private filterSettingsSections(query: string): void {
    let matchCount = 0
    this.settingsSectionButtons.forEach((button, key) => {
      const section = this.settingsSections.get(key)
      const result = this.settingsSectionResults.get(key)
      const matches = this.settingsSectionMatches.get(key)
      const label = button.dataset.settingsLabel || ""
      const match = section ? matchSettingsSection(section, label, query) : null
      if (result) result.hidden = match === null
      if (match !== null) matchCount++
      if (matches) {
        matches.textContent = ""
        for (const item of match?.matches || []) {
          const matchButton = document.createElement("button")
          matchButton.type = "button"
          matchButton.className = "settings_section_match"
          matchButton.textContent = item.text
          matchButton.title = `Open ${label}: ${item.text}`
          matchButton.onmousedown = (event) => {
            event.preventDefault()
          }
          matchButton.onclick = () => {
            this.openSettingsSearchMatch(key, item)
          }
          matches.append(matchButton)
        }
        const hiddenMatchCount =
          match ? match.totalMatches - match.matches.length : 0
        if (hiddenMatchCount > 0) {
          const more = document.createElement("small")
          more.className = "settings_section_more"
          more.textContent = `${hiddenMatchCount} more matches`
          matches.append(more)
        }
        matches.hidden = matches.childElementCount === 0
      }
    })
    requireElement<HTMLElement>("#settings_search_empty").hidden =
      matchCount !== 0
  }

  /** Also called from outside after a keybinding change re-labels its rows. */
  refreshSettingsSearch(): void {
    if (this.settingsSectionButtons.size === 0) return
    this.updateSettingsSummaries()
    const search = document.querySelector<HTMLInputElement>("#settings_search")
    if (search) this.filterSettingsSections(search.value)
  }

  private updateSettingsSummaries(): void {
    updateSettingsSummaries(
      this.settingsSectionButtons,
      this.sourceErrors.size
    )
  }

  private openSettingsSearchMatch(
    key: string,
    match: SettingsSearchMatch
  ): void {
    this.openSettingsSection(key)
    if (!match.controlId && !match.targetId) return
    const controlId = match.controlId
    const targetId = match.targetId
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (match.startIndex !== undefined &&
            this.structuredEditors?.openSettingsSearchMatch(
              key,
              match.startIndex
            )) {
          return
        }
        if (targetId) {
          const target = document.getElementById(targetId)
          if (!target) return
          if (target instanceof HTMLDetailsElement) target.open = true
          target.focus({ preventScroll: true })
          revealElement(target, { block: "center" })
          return
        }
        if (!controlId) return
        const control = document.getElementById(controlId)
        if (!(control instanceof HTMLInputElement ||
              control instanceof HTMLTextAreaElement ||
              control instanceof HTMLSelectElement)) {
          return
        }
        control.focus({ preventScroll: true })
        if ((control instanceof HTMLInputElement ||
             control instanceof HTMLTextAreaElement) &&
            match.startIndex !== undefined) {
          control.setSelectionRange(
            match.startIndex,
            match.endIndex ?? match.startIndex
          )
          if (control instanceof HTMLTextAreaElement) {
            scrollTextareaSelectionIntoView(control, match.startIndex)
            return
          }
        }
        revealElement(control, { block: "center" })
      })
    })
  }

  private openSettingsSection(key: string): void {
    this.activeSettingsSection = key
    this.settingsSectionButtons.forEach((button, buttonKey) => {
      if (buttonKey === key) button.setAttribute("aria-current", "page")
      else button.removeAttribute("aria-current")
    })
    document.querySelectorAll<HTMLElement>(".settings_section").forEach((section) => {
      section.classList.toggle("active", section.dataset.settingsSection === key)
    })
    requireElement("#settings_panel").classList.add("settings_detail_open")
    const back = requireElement<HTMLButtonElement>("#settings_section_back")
    const label = this.settingsSectionButtons.get(key)?.dataset.settingsLabel
    requireElement("#settings_panel .settings_title").textContent = label || "Settings"
    this.structuredEditors?.setActiveSection(key)
    requestAnimationFrame(() => {
      const isMobileStructuredSection =
        document.body.dataset.platform === "mobile" &&
        (key === "sources" || key === "filters" || key === "redirects")
      if (isMobileStructuredSection) {
        back.focus({ preventScroll: true })
        return
      }
      const first = document.querySelector<HTMLElement>(
        `.settings_section[data-settings-section="${key}"] input, ` +
        `.settings_section[data-settings-section="${key}"] select, ` +
        `.settings_section[data-settings-section="${key}"] textarea, ` +
        `.settings_section[data-settings-section="${key}"] button`
      )
      if (!first) return
      first.focus({ preventScroll: true })
      revealElement(first)
    })
  }

  /**
   * A full-screen editor inside a section is a modal task, not navigation: it
   * takes the header's title and hides the chrome belonging to the list behind
   * it. Passing null restores the section's own title.
   */
  private setSettingsDetailTitle(title: string | null): void {
    const panel = requireElement("#settings_panel")
    panel.classList.toggle("settings_form_open", Boolean(title))
    if (title) {
      requireElement("#settings_panel .settings_title").textContent = title
      return
    }
    if (!this.activeSettingsSection) return
    const label = this.settingsSectionButtons
      .get(this.activeSettingsSection)?.dataset.settingsLabel
    requireElement("#settings_panel .settings_title").textContent =
      label || "Settings"
  }

  private closeSettingsSection(): void {
    const previous = this.activeSettingsSection
    if (previous === "sources" && this.sourcesReloadPending) {
      this.sourcesReloadPending = false
      const pending = this.sourcesSaveChain
      void pending.then(() => this.client.reloadStories(true)).catch((error) => {
        console.error("Failed to save story-source ordering", error)
      })
    }
    this.activeSettingsSection = null
    this.settingsSectionButtons.forEach((button) =>
      button.removeAttribute("aria-current"))
    document.querySelectorAll<HTMLElement>(".settings_section").forEach((section) => {
      section.classList.remove("active")
    })
    requireElement("#settings_panel").classList.remove("settings_detail_open")
    requireElement("#settings_panel .settings_title").textContent = "Settings"
    this.structuredEditors?.setActiveSection(null)
    if (previous) this.settingsSectionButtons.get(previous)?.focus()
  }

  private showSettingsIndex(): void {
    this.closeSettingsSection()
    const search = requireElement<HTMLInputElement>("#settings_search")
    search.value = ""
    this.filterSettingsSections("")
    requireElement<HTMLElement>("#settings_index").scrollTop = 0
  }

  showErrorLog(logId: string): void {
    panelNavigation.open_panel("settings")
    this.openSettingsSection("errors")
    requestAnimationFrame(() => {
      const entry = document.querySelector<HTMLDetailsElement>(`#${logId}`)
      if (!entry) return
      entry.open = true
      entry.focus({ preventScroll: true })
      revealElement(entry, { block: "center" })
    })
  }

  showSourceErrorLog(sourceId: string): void {
    const sourceUrl = this.sourceErrors.get(sourceId)?.url
    if (!sourceUrl) return
    panelNavigation.open_panel("settings")
    this.openSettingsSection("errors")
    requestAnimationFrame(() => {
      const entries = Array.from(
        document.querySelectorAll<HTMLDetailsElement>(
          "#error_log .error_log_entry[data-source-url]"
        )
      ).filter((entry) => entry.dataset.sourceUrl === sourceUrl)
      const latest = entries[entries.length - 1]
      if (!latest) return
      entries.forEach((entry) => {
        entry.open = true
      })
      latest.focus({ preventScroll: true })
      revealElement(latest, { block: "center" })
    })
  }

  clearSourceErrors(): void {
    this.setSourceErrors([])
  }

  showStory(storyUrl: string): void {
    panelNavigation.open_panel("stories")
    void this.client.selectUrl(storyUrl)
  }

  async reset_couch_settings(): Promise<void> {
    await this.persistence.restoreSync()
  }

  save_couch_settings(): void {
    const couch_input =
      requireElement<HTMLInputElement>("#couch_input")
    const status = requireElement<HTMLElement>("#couch_status")
    status.dataset.state = couch_input.value.trim() ? "connecting" : "disabled"
    status.textContent = couch_input.value.trim()
      ? "Saving and connecting…"
      : "Turning sync off…"
    this.client.setSyncUrl(couch_input.value).then(
      () => {
        // Trigger password highlighting update using existing input event listener
        couch_input.dispatchEvent(new Event("input"))
        const current = this.client.getSyncStatus()
        status.dataset.state = current.state
        status.textContent = current.message
      },
      (error) => {
        status.dataset.state = "error"
        status.textContent = error instanceof Error
          ? error.message
          : "The sync setting could not be saved"
      }
    )
  }

  async restore_theme_settings(): Promise<void> {
    await this.persistence.restoreTheme()
  }

  save_theme(name: string): void {
    this.persistence.saveTheme(name)
  }

  async restore_animation_settings(): Promise<void> {
    await this.persistence.restoreAnimation()
  }

  save_animation(checked: boolean): void {
    this.persistence.saveAnimation(checked)
  }

  set_animation(checked: boolean): void {
    this.persistence.applyAnimation(checked)
  }

  set_theme(name: string): void {
    this.persistence.applyTheme(name)
  }

  async set_sources_area(): Promise<void> {
    const sources_area =
      requireElement<HTMLTextAreaElement>("#sources_area")
    const story_sources = await this.client.getStorySources()
    sources_area.value = serializeStorySourceDocument(story_sources)
    // Trigger input event to update highlights
    sources_area.dispatchEvent(new Event("input"))
    this.structuredEditors?.sync("sources")
    this.refreshSettingsSearch()
  }

  async save_sources_settings(): Promise<void> {
    const sources_area =
      requireElement<HTMLTextAreaElement>("#sources_area")
    const existing = await this.client.getStorySources()
    const parsed = parseStorySourceText(sources_area.value, existing)
    if (!parsed.ok || !parsed.doc) {
      throw new Error(parsed.reports.map((item) => `${item.path}: ${item.message}`).join("\n"))
    }
    sources_area.value = serializeStorySourceDocument(parsed.doc)

    await this.sourcesSaveChain
    this.sourcesReloadPending = false
    await this.client.saveStorySources(parsed.doc)
  }

  async set_filter_area(): Promise<void> {
    const filter_area =
      requireElement<HTMLInputElement>("#filter_area")
    const filter_list = await this.client.getFilterList()
    filter_area.value = filter_list.join("\n")
    this.structuredEditors?.sync("filters")
    this.refreshSettingsSearch()
  }

  save_filter_settings(): void {
    const filter_area =
      requireElement<HTMLInputElement>("#filter_area")
    const filter_list = filter_area.value.split("\n").filter((x) => {
      return x.trim() != ""
    })
    this.client.saveFilterList(filter_list)
  }

  async set_redirect_area(): Promise<void> {
    const redirect_area =
      requireElement<HTMLInputElement>("#redirect_area")
    const redirect_list = await this.client.getRedirectList()
    redirect_area.value = presentRedirectList(redirect_list)
    this.structuredEditors?.sync("redirects")
    this.refreshSettingsSearch()
  }

  save_redirect_settings(): void {
    const redirect_area =
      requireElement<HTMLInputElement>("#redirect_area")
    const redirect_list = parseRedirectList(redirect_area.value)
    this.client.saveRedirectList(redirect_list)
  }

  private sourceErrors = new Map<string, SourceError>()

  private setSourceErrors(errors: SourceError[]): void {
    this.sourceErrors = new Map(
      errors.map((error) => [error.sourceId, error])
    )
    this.updateSourcesDisplay()
    this.structuredEditors?.setErrors(errors)
    this.refreshSettingsSearch()
  }

  private updateSourcesDisplay(): void {
    const sources_area =
      document.querySelector<HTMLTextAreaElement>("#sources_area")
    if (sources_area) {
      // Trigger input event to update highlights
      sources_area.dispatchEvent(new Event("input"))
    }
  }

  public highlight_filter(filter: string, shouldOpenPanel = true): void {
    console.log("SettingsPanel: highlighting filter", filter)
    if (shouldOpenPanel) this.openSettingsSection("filters")
    if (shouldOpenPanel && this.structuredEditors?.focusFilter(filter)) return
    highlightTextareaContent(
      "filter_area",
      filter,
      shouldOpenPanel,
      false,
      () => panelNavigation.open_panel("settings")
    )
  }

  public highlightSource(sourceId: string): void {
    this.openSettingsSection("sources")
    // openSettingsSection queues its default section focus for the next frame.
    // Reveal the requested source afterwards so that default focus cannot
    // immediately steal focus back from the highlighted row.
    requestAnimationFrame(() => {
      if (this.structuredEditors?.focusSource(sourceId)) return
    })
  }

  async restore_cache_settings(): Promise<void> {
    await this.persistence.restoreCache()
  }

  async save_cache_settings(): Promise<void> {
    await this.persistence.saveCache()
  }
}
