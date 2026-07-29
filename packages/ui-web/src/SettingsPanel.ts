import { OnceClient, SourceError } from "@once/app"
import { parseRedirectList, presentRedirectList } from "@once/core"
import { requireClosestElement, requireElement } from "./dom"
import * as menu from "./menu"
import {
  matchSettingsSection,
  SettingsSearchMatch
} from "./SettingsSearch"
import { SwipeSettingsLab } from "./SwipeSettingsLab"
import { StructuredSettingsEditors } from "./StructuredSettingsEditors"
import { SettingsPersistence } from "./settings/SettingsPersistence"

export class SettingsPanel {
  static instance: SettingsPanel
  readonly ready: Promise<void>
  private structuredEditors?: StructuredSettingsEditors
  private swipeLab?: SwipeSettingsLab
  private sourcesSaveChain: Promise<void> = Promise.resolve()
  private sourcesReloadPending = false
  private persistence: SettingsPersistence

  constructor(private client: OnceClient) {
    this.persistence = new SettingsPersistence(
      client,
      () => this.refreshSettingsSearch()
    )
    SettingsPanel.instance = this
    client.subscribe("settingsChanged", ({ section }) => {
      switch (section) {
        case "filters":
          this.set_filter_area()
          break
        case "redirects":
          this.set_redirect_area()
          break
        case "sources":
          this.set_sources_area()
          break
        case "theme":
          this.restore_theme_settings()
          break
        case "animation":
          this.restore_animation_settings()
          break
        case "cache":
          this.restore_cache_settings()
          break
        case "sync":
          this.reset_couch_settings()
          break
        case "swipe":
          this.swipeLab?.externalSettingsChanged()
          break
      }
    })
    client.subscribe("sourceErrorsChanged", ({ errors }) => {
      this.setSourceErrors(errors)
    })
    const setSyncStatus = (status: ReturnType<OnceClient["getSyncStatus"]>) => {
      const element = requireElement<HTMLElement>("#couch_status")
      element.dataset.state = status.state
      element.textContent = status.message
      this.updateSettingsSummaries()
    }
    client.subscribe("syncStatusChanged", setSyncStatus)
    setSyncStatus(client.getSyncStatus())

    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", (e) => {
        console.debug("system theme change", e)
      })

    this.restore_theme_settings()

    const theme_select =
      requireElement<HTMLSelectElement>("#theme_select")
    theme_select.addEventListener("change", () => {
      this.save_theme(theme_select.value)
    })

    const anim_checkbox =
      requireElement<HTMLInputElement>("#anim_checkbox")
    this.restore_animation_settings()
    anim_checkbox.addEventListener("change", () => {
      this.save_animation(anim_checkbox.checked)
    })

    const couch_input =
      requireElement<HTMLInputElement>("#couch_input")
    const couch_container = couch_input.parentElement
    if (!couch_container) {
      const message = "Settings are unavailable because the sync URL container is missing"
      throw new Error(message)
    }
    const couch_highlights =
      requireElement<HTMLElement>(".couch-highlights", couch_container)
    const couch_toggle =
      requireElement<HTMLButtonElement>("#couch_toggle", couch_container)
    const couch_actions = couch_container.parentElement
    if (!couch_actions) {
      const message = "Settings are unavailable because the sync actions are missing"
      throw new Error(message)
    }

    const updateCouchHighlights = () => {
      const val = couch_input.value
      if (!val) {
        couch_highlights.textContent = ""
        return
      }
      couch_toggle.textContent = couch_container.classList.contains("masked")
        ? "👁️"
        : "🙈"

      try {
        const url = new URL(val)
        if (url.password && couch_container.classList.contains("masked")) {
          // Mask the password part
          const maskedPassword = "•".repeat(url.password.length)
          // Reconstruct the display string: protocol://user:••••@host...
          // We can't just set url.password because it encodes it
          // Better to use a simple string rebuild or handle the components
          // Actually, let's be more robust:
          // Find the last ':' before '@' and the '@' itself
          const authEnd = val.lastIndexOf("@")
          const passStart = val.lastIndexOf(":", authEnd)

          if (passStart !== -1 && passStart < authEnd) {
            const before = val.substring(0, passStart + 1)
            const after = val.substring(authEnd)
            couch_highlights.textContent = before + maskedPassword + after
          } else {
            couch_highlights.textContent = val
          }
        } else {
          couch_highlights.textContent = val
        }
      } catch (e) {
        // Not a full URL or invalid, just show as is
        couch_highlights.textContent = val
      }
    }

    // Make highlights clickable to toggle masking
    couch_highlights.style.pointerEvents = "auto"
    couch_highlights.style.cursor = "pointer"
    couch_highlights.addEventListener("click", () => {
      couch_container.classList.toggle("masked")
      updateCouchHighlights()
    })

    couch_toggle.addEventListener("click", (e) => {
      e.preventDefault()
      couch_container.classList.toggle("masked")
      couch_toggle.textContent = couch_container.classList.contains("masked")
        ? "👁️"
        : "🙈"
      updateCouchHighlights()
    })

    couch_input.addEventListener("input", updateCouchHighlights)

    this.reset_couch_settings().then(() => updateCouchHighlights())

    requireElement<HTMLInputElement>(
      'input[value="save"]',
      couch_actions
    )
      .addEventListener("click", () => {
        this.save_couch_settings()
      })
    requireElement<HTMLInputElement>(
      'input[value="cancel"]',
      couch_actions
    )
      .addEventListener("click", () => {
        this.reset_couch_settings().then(() => updateCouchHighlights())
      })

    this.ready = this.set_sources_area()

    const sources_area =
      requireElement<HTMLInputElement>("#sources_area")
    const sources_block = requireClosestElement<HTMLElement>(
      sources_area,
      ".settings_block"
    )
    const saveSourcesButton = requireElement<HTMLInputElement>(
      'input[value="save"]',
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
    requireElement<HTMLInputElement>(
      'input[value="cancel"]',
      sources_block
    )
      .addEventListener("click", () => {
        this.set_sources_area()
      })

    sources_area.addEventListener("keydown", (e) => {
      if (e.keyCode === 27) {
        //ESC
        this.set_sources_area()
      } else if (e.key == "s" && e.ctrlKey) {
        //CTRL + s
        this.save_sources_settings()
      }
    })

    const highlights = requireElement<HTMLElement>(".highlights")

    const handleInput = () => {
      const text = sources_area.value
      highlights.innerHTML = ""

      const lines = text.split("\n")

      lines.forEach((line) => {
        const sourceError = this.sourceErrors.get(line.trim())

        const lineContainer = document.createElement("div")
        lineContainer.classList.add("line-mirrored")

        if (sourceError) {
          lineContainer.classList.add("error-line")
          const icon = document.createElement("div")

          const isWarning = sourceError.type === "warning"
          icon.classList.add("error-icon")
          icon.textContent = isWarning ? "⚠️" : "❗"
          icon.title = isWarning
            ? "Click for warning details"
            : "Click for error details"
          icon.style.pointerEvents = "auto"
          icon.style.cursor = "pointer"
          icon.onclick = () => {
            this.showSourceErrorLog(sourceError.url)
          }
          lineContainer.appendChild(icon)

          const mark = document.createElement("mark")
          mark.textContent = line || " "
          lineContainer.appendChild(mark)
        } else {
          lineContainer.textContent = line || " "
        }

        highlights.appendChild(lineContainer)
      })
    }

    const handleScroll = () => {
      highlights.scrollTop = sources_area.scrollTop
    }

    sources_area.addEventListener("input", handleInput)
    sources_area.addEventListener("scroll", handleScroll)
    // Initial sync
    handleInput()

    this.set_filter_area()

    const filter_area =
      requireElement<HTMLInputElement>("#filter_area")
    const filter_block = requireClosestElement<HTMLElement>(
      filter_area,
      ".settings_block"
    )
    requireElement<HTMLInputElement>(
      'input[value="save"]',
      filter_block
    )
      .addEventListener("click", () => {
        this.save_filter_settings()
      })
    requireElement<HTMLInputElement>(
      "input[value=cancel]",
      filter_block
    )
      .addEventListener("click", () => {
        this.set_filter_area()
      })

    filter_area.addEventListener("keydown", (e) => {
      if (e.keyCode === 27) {
        //ESC
        this.set_filter_area()
      } else if (e.key == "s" && e.ctrlKey) {
        //CTRL + s
        this.save_filter_settings()
      }
    })

    this.set_redirect_area()

    const redirect_area =
      requireElement<HTMLInputElement>("#redirect_area")
    const redirect_block = requireClosestElement<HTMLElement>(
      redirect_area,
      ".settings_block"
    )
    requireElement<HTMLInputElement>(
      'input[value="save"]',
      redirect_block
    )
      .addEventListener("click", () => {
        this.save_redirect_settings()
      })
    requireElement<HTMLInputElement>(
      "input[value=cancel]",
      redirect_block
    )
      .addEventListener("click", () => {
        this.set_redirect_area()
      })

    redirect_area.addEventListener("keydown", (e) => {
      if (e.keyCode === 27) {
        //ESC
        this.set_filter_area()
      } else if (e.key == "s" && e.ctrlKey) {
        //CTRL + s
        this.save_redirect_settings()
      }
    })

    this.swipeLab = new SwipeSettingsLab(
      requireElement<HTMLElement>("#swipe_lab"),
      this.client,
      () => {
        this.updateSettingsSummaries()
        this.refreshSettingsSearch()
      }
    )

    // Cache timing settings
    this.restore_cache_settings()
    const cache_time_input =
      requireElement<HTMLInputElement>("#cache_time_input")
    const cache_block = requireClosestElement<HTMLElement>(
      cache_time_input,
      ".settings_block"
    )
    requireElement<HTMLInputElement>("#cache_time_save", cache_block)
      .addEventListener("click", () => {
        this.save_cache_settings()
      })
    requireElement<HTMLInputElement>("#cache_time_cancel", cache_block)
      .addEventListener("click", () => {
        this.restore_cache_settings()
      })

    cache_time_input.addEventListener("keydown", (e) => {
      if (e.keyCode === 27) {
        //ESC
        this.restore_cache_settings()
      } else if (e.key == "s" && e.ctrlKey) {
        //CTRL + s
        this.save_cache_settings()
      }
    })

    this.structuredEditors = new StructuredSettingsEditors({
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
    this.structuredEditors.sync("sources")
    this.structuredEditors.sync("filters")
    this.structuredEditors.sync("redirects")
    this.installSettingsNavigation()
  }

  private activeSettingsSection: string | null = null
  private settingsSectionButtons = new Map<string, HTMLButtonElement>()
  private settingsSections = new Map<string, HTMLElement>()
  private settingsSectionResults = new Map<string, HTMLElement>()
  private settingsSectionMatches = new Map<string, HTMLElement>()

  private installSettingsNavigation(): void {
    const definitions = [
      ["sources", "Story sources", "#sources_area"],
      ["filters", "Filters", "#filter_area"],
      ["redirects", "Redirects", "#redirect_area"],
      ["sync", "CouchDB Sync", "#couch_input"],
      ["theme", "Theme & animations", "#theme_select"],
      ["swipe", "Swipe actions", "#swipe_lab"],
      ["cache", "Cache timing", "#cache_time_input"],
      ["errors", "Error log", "#error_log"],
      ["about", "About Once", "[data-testid='app-version']"]
    ] as const
    const index = requireElement<HTMLElement>("#settings_sections")
    const search = requireElement<HTMLInputElement>("#settings_search")
    const back = requireElement<HTMLButtonElement>("#settings_section_back")
    const noResults = document.createElement("p")
    noResults.id = "settings_search_empty"
    noResults.textContent = "No settings found"
    noResults.setAttribute("role", "status")
    noResults.setAttribute("aria-live", "polite")
    noResults.hidden = true

    for (const [key, label, selector] of definitions) {
      const control = requireElement<HTMLElement>(selector)
      const block = requireClosestElement<HTMLElement>(control, ".settings_block")
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
    back.onclick = () => {
      if (this.structuredEditors?.handleBack(this.activeSettingsSection)) return
      this.closeSettingsSection()
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

  private refreshSettingsSearch(): void {
    if (this.settingsSectionButtons.size === 0) return
    this.updateSettingsSummaries()
    const search = document.querySelector<HTMLInputElement>("#settings_search")
    if (search) this.filterSettingsSections(search.value)
  }

  private updateSettingsSummaries(): void {
    if (this.settingsSectionButtons.size === 0) return
    const value = (selector: string) =>
      document.querySelector<HTMLInputElement | HTMLTextAreaElement |
        HTMLSelectElement>(selector)?.value || ""
    const lineCount = (text: string) =>
      text.split("\n").filter((line) => line.trim()).length
    const sourceLines = value("#sources_area").split("\n")
      .map((line) => line.trim()).filter(Boolean)
    const sourceCount = sourceLines.filter((line) => !line.startsWith("*")).length
    const filterCount = lineCount(value("#filter_area"))
    const redirectCount = lineCount(value("#redirect_area"))
    const animation = document.querySelector<HTMLInputElement>("#anim_checkbox")
      ?.checked ? "animated" : "still"
    const theme = value("#theme_select") || "system"
    const swipeRight = document.querySelector<HTMLSelectElement>(
      '[data-swipe="right-0"]'
    )?.selectedOptions[0]?.textContent || "Read"
    const swipeLeft = document.querySelector<HTMLSelectElement>(
      '[data-swipe="left-0"]'
    )?.selectedOptions[0]?.textContent || "skip"
    const errorRow = this.settingsSectionButtons.get("errors")
    const errorCount = Number(errorRow?.dataset.errorCount || 0)
    const warningCount = Number(errorRow?.dataset.warningCount || 0)
    const sourceFailures = this.sourceErrors.size
    const summaries: Record<string, { text: string, error?: boolean }> = {
      sources: {
        text: `${sourceCount}${sourceFailures ? ` · ${sourceFailures} failing` : ""}`,
        error: sourceFailures > 0
      },
      filters: { text: `${filterCount} ${filterCount === 1 ? "keyword" : "keywords"}` },
      redirects: { text: `${redirectCount} ${redirectCount === 1 ? "rule" : "rules"}` },
      sync: {
        text: document.querySelector("#couch_status")?.textContent?.trim() ||
          "Not configured"
      },
      theme: { text: `${theme[0]?.toUpperCase()}${theme.slice(1)} · ${animation}` },
      swipe: { text: `${swipeRight} · ${swipeLeft}` },
      cache: { text: `${value("#cache_time_input") || "30"} min` },
      errors: {
        text: errorCount || warningCount
          ? `${errorCount} error${errorCount === 1 ? "" : "s"} · ` +
            `${warningCount} warning${warningCount === 1 ? "" : "s"}`
          : "No issues",
        error: errorCount > 0
      },
      about: {
        text: document.querySelector("[data-testid='app-version']")
          ?.textContent?.trim() || ""
      }
    }
    for (const [key, summary] of Object.entries(summaries)) {
      const element = this.settingsSectionButtons.get(key)
        ?.querySelector<HTMLElement>(".settings_section_summary")
      if (!element) continue
      element.textContent = summary.text
      element.classList.toggle("settings_section_summary_error", Boolean(summary.error))
    }
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
          target.scrollIntoView({ block: "center" })
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
            this.scrollTextareaSelectionIntoView(control, match.startIndex)
            return
          }
        }
        control.scrollIntoView({ block: "center" })
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
    back.hidden = false
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
      document.querySelector<HTMLElement>(
        `.settings_section[data-settings-section="${key}"] input, ` +
        `.settings_section[data-settings-section="${key}"] select, ` +
        `.settings_section[data-settings-section="${key}"] textarea, ` +
        `.settings_section[data-settings-section="${key}"] button`
      )?.focus()
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
    requireElement<HTMLButtonElement>("#settings_section_back").hidden = true
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
    menu.open_panel("settings")
    this.openSettingsSection("errors")
    requestAnimationFrame(() => {
      const entry = document.querySelector<HTMLDetailsElement>(`#${logId}`)
      if (!entry) return
      entry.open = true
      entry.scrollIntoView({ block: "center" })
      entry.focus()
    })
  }

  showSourceErrorLog(sourceUrl: string): void {
    menu.open_panel("settings")
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
      latest.scrollIntoView({ block: "center" })
      latest.focus()
    })
  }

  clearSourceErrors(): void {
    this.setSourceErrors([])
  }

  showStory(storyUrl: string): void {
    menu.open_panel("stories")
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
      () => {
        status.dataset.state = "error"
        status.textContent = "The sync setting could not be saved"
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
    sources_area.value = story_sources.join("\n")
    // Trigger input event to update highlights
    sources_area.dispatchEvent(new Event("input"))
    this.structuredEditors?.sync("sources")
    this.refreshSettingsSearch()
  }

  async save_sources_settings(): Promise<void> {
    const sources_area =
      requireElement<HTMLTextAreaElement>("#sources_area")
    const story_sources = sources_area.value.split("\n").filter((x) => {
      return x.trim() != ""
    })

    await this.sourcesSaveChain
    this.sourcesReloadPending = false
    await this.client.saveStorySources(story_sources)
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
      errors.map((error) => [error.url.trim(), error])
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

  private highlight_textarea_content(
    textareaId: string,
    searchText: string,
    shouldOpenPanel = true,
    triggerInputEvent = false
  ): void {
    if (shouldOpenPanel) {
      // Switch panel to settings directly
      menu.open_panel("settings")
    }

    const textarea = requireElement<HTMLTextAreaElement>(`#${textareaId}`)

    // Trigger input event if needed (for sources highlighting)
    if (triggerInputEvent) {
      textarea.dispatchEvent(new Event("input"))
    }

    if (!shouldOpenPanel) {
      return // Don't scroll if panel shouldn't be opened
    }

    // Find the text in the textarea
    const text = textarea.value
    const lines = text.split("\n")
    let startIndex = -1

    // Look for exact match first
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim()
      if (line === searchText.trim()) {
        // Find the start position of this line in the full text
        if (i === 0) {
          startIndex = 0
        } else {
          startIndex = lines.slice(0, i).join("\n").length + 1 // +1 for the newline
        }
        break
      }
    }

    // If no exact match, try partial match
    if (startIndex === -1) {
      startIndex = text.indexOf(searchText)
    }

    if (startIndex !== -1) {
      console.log(`SettingsPanel: scrolling to ${textareaId}`, searchText)
      textarea.focus({ preventScroll: true })
      textarea.setSelectionRange(startIndex, startIndex + searchText.length)
      this.scrollTextareaSelectionIntoView(textarea, startIndex)
    } else {
      console.warn(
        `SettingsPanel: could not find text in ${textareaId}`,
        searchText
      )
    }
  }

  private scrollTextareaSelectionIntoView(
    textarea: HTMLTextAreaElement,
    startIndex: number
  ): void {
    const lineIndex = textarea.value.slice(0, startIndex).split("\n").length - 1

    // Chromium does not consistently scroll a textarea to setSelectionRange().
    // Wait until the newly opened settings panel has been laid out, then scroll
    // both the settings list and the textarea explicitly.
    requestAnimationFrame(() => {
      textarea.closest(".settings_block")?.scrollIntoView({
        block: "nearest"
      })

      const highlights = textarea
        .closest(".input_container")
        ?.querySelector<HTMLElement>(".highlights")
      const mirroredLine = highlights?.children.item(lineIndex) as
        | HTMLElement
        | null
      const style = getComputedStyle(textarea)
      const lineHeight =
        parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.2
      const targetTop = mirroredLine
        ? mirroredLine.offsetTop
        : (parseFloat(style.paddingTop) || 0) + lineIndex * lineHeight
      const targetHeight = mirroredLine?.offsetHeight || lineHeight
      const centeredTop =
        targetTop - Math.max(0, (textarea.clientHeight - targetHeight) / 2)

      textarea.scrollTop = Math.max(
        0,
        Math.min(centeredTop, textarea.scrollHeight - textarea.clientHeight)
      )
      textarea.dispatchEvent(new Event("scroll"))
    })
  }

  public highlight_filter(filter: string, shouldOpenPanel = true): void {
    console.log("SettingsPanel: highlighting filter", filter)
    if (shouldOpenPanel) this.openSettingsSection("filters")
    if (shouldOpenPanel && this.structuredEditors?.focusFilter(filter)) return
    this.highlight_textarea_content(
      "filter_area",
      filter,
      shouldOpenPanel,
      false
    )
  }

  public highlightSource(sourceUrl: string): void {
    this.openSettingsSection("sources")
    // openSettingsSection queues its default section focus for the next frame.
    // Reveal the requested source afterwards so that default focus cannot
    // immediately steal focus back from the highlighted row.
    requestAnimationFrame(() => {
      if (this.structuredEditors?.focusSource(sourceUrl)) return
      this.highlight_textarea_content("sources_area", sourceUrl, true, true)
    })
  }

  async restore_cache_settings(): Promise<void> {
    await this.persistence.restoreCache()
  }

  async save_cache_settings(): Promise<void> {
    await this.persistence.saveCache()
  }
}
