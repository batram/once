import {
  DEFAULT_SWIPE_SETTINGS,
  normalizeSwipeSettings,
  OnceClient,
  SourceError,
  SWIPE_ACTION_LABELS,
  SwipeActionId,
  SwipeSettings,
  ThemeName
} from "@once/app"
import { parseRedirectList, presentRedirectList } from "@once/core"
import { requireClosestElement, requireElement } from "./dom"
import * as menu from "./menu"
import { installSwipePreview } from "./SwipePreviewRow"

export class SettingsPanel {
  static instance: SettingsPanel
  readonly ready: Promise<void>

  constructor(private client: OnceClient) {
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
          this.restore_swipe_settings()
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
    requireElement<HTMLInputElement>(
      'input[value="save"]',
      sources_block
    )
      .addEventListener("click", () => {
        this.save_sources_settings()
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

    // Swipe action settings
    this.build_swipe_controls()
    void this.restore_swipe_settings()
    // Reads the form, not the stored settings, so edits can be tried out
    // before they are saved.
    installSwipePreview(
      requireElement<HTMLElement>("#swipe_preview"),
      () => normalizeSwipeSettings(this.read_swipe_settings())
    )
    const swipe_block = requireClosestElement<HTMLElement>(
      requireElement<HTMLElement>("#swipe_stages"),
      ".settings_block"
    )
    requireElement<HTMLInputElement>('input[value="save"]', swipe_block)
      .addEventListener("click", () => {
        void this.save_swipe_settings()
      })
    requireElement<HTMLInputElement>('input[value="cancel"]', swipe_block)
      .addEventListener("click", () => {
        void this.restore_swipe_settings()
      })
    requireElement<HTMLInputElement>("#swipe_reset", swipe_block)
      .addEventListener("click", () => {
        this.apply_swipe_settings(DEFAULT_SWIPE_SETTINGS)
        void this.save_swipe_settings()
      })
    requireElement<HTMLInputElement>("#swipe_two_stage")
      .addEventListener("change", () => {
        this.update_swipe_disabled_state()
      })

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
  }

  showErrorLog(logId: string): void {
    menu.open_panel("settings")
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
    const couch_input =
      requireElement<HTMLInputElement>("#couch_input")
    couch_input.value = await this.client.getSyncUrl()
    // Trigger password highlighting update using existing function
    couch_input.dispatchEvent(new Event("input"))
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
    const theme_value = await this.client.getTheme()

    const theme_select =
      requireElement<HTMLSelectElement>("#theme_select")
    theme_select.value = theme_value
    this.set_theme(theme_value)
  }

  save_theme(name: string): void {
    this.client.setTheme(name as ThemeName)
    this.set_theme(name)
  }

  async restore_animation_settings(): Promise<void> {
    const checked = await this.client.getAnimation()

    const anim_checkbox =
      requireElement<HTMLInputElement>("#anim_checkbox")
    anim_checkbox.checked = checked
    this.set_animation(checked)
  }

  save_animation(checked: boolean): void {
    this.client.setAnimation(checked)
    const anim_checkbox =
      requireElement<HTMLInputElement>("#anim_checkbox")
    anim_checkbox.checked = checked
    this.set_animation(checked)
  }

  set_animation(checked: boolean): void {
    document.body.setAttribute("animated", checked.toString())
  }

  set_theme(name: string): void {
    document.body.removeAttribute("data-theme")
    switch (name) {
      case "dark":
        document.body.setAttribute("data-theme", "dark")
        break
      case "light":
        document.body.setAttribute("data-theme", "light")
        break
      case "custom":
        console.debug("custom theme, not implement, just hanging out here :D")
        break
      case "system":
        break
    }
  }

  async set_sources_area(): Promise<void> {
    const sources_area =
      requireElement<HTMLTextAreaElement>("#sources_area")
    const story_sources = await this.client.getStorySources()
    sources_area.value = story_sources.join("\n")
    // Trigger input event to update highlights
    sources_area.dispatchEvent(new Event("input"))
  }

  async save_sources_settings(): Promise<void> {
    const sources_area =
      requireElement<HTMLTextAreaElement>("#sources_area")
    const story_sources = sources_area.value.split("\n").filter((x) => {
      return x.trim() != ""
    })

    this.client.saveStorySources(story_sources)
  }

  async set_filter_area(): Promise<void> {
    const filter_area =
      requireElement<HTMLInputElement>("#filter_area")
    const filter_list = await this.client.getFilterList()
    filter_area.value = filter_list.join("\n")
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
    this.highlight_textarea_content(
      "filter_area",
      filter,
      shouldOpenPanel,
      false
    )
  }

  public highlightSource(sourceUrl: string): void {
    this.highlight_textarea_content("sources_area", sourceUrl, true, true)
  }

  /**
   * One row per stage: how far the drag must travel, where the row rests
   * while it is engaged, and what each direction does when released there.
   * Generated rather than hand-written so the control count stays tied to
   * the number of stages in SwipeSettings.
   */
  private build_swipe_controls(): void {
    const container = requireElement<HTMLElement>("#swipe_stages")
    container.textContent = ""

    const header = document.createElement("div")
    header.classList.add("swipe_row", "swipe_head")
    for (const label of ["", "engages at", "rests at", "swipe right", "swipe left"]) {
      const cell = document.createElement("span")
      cell.textContent = label
      header.append(cell)
    }
    container.append(header)

    for (const stage of [0, 1] as const) {
      const row = document.createElement("div")
      row.classList.add("swipe_row")
      row.dataset.stage = String(stage + 1)

      const name = document.createElement("span")
      name.textContent = `Stage ${stage + 1}`
      row.append(name)

      for (const field of ["threshold", "offset"] as const) {
        const input = document.createElement("input")
        input.type = "number"
        input.min = "16"
        input.max = "1000"
        input.step = "1"
        input.dataset.swipe = `${field}-${stage}`
        input.dataset.testid = `swipe-${field}-${stage + 1}`
        input.setAttribute(
          "aria-label",
          `Stage ${stage + 1} ${field === "threshold" ? "threshold" : "resting offset"} in pixels`
        )
        row.append(input)
      }

      for (const direction of ["right", "left"] as const) {
        const select = document.createElement("select")
        select.dataset.swipe = `${direction}-${stage}`
        select.dataset.testid = `swipe-${direction}-${stage + 1}`
        select.setAttribute(
          "aria-label",
          `Stage ${stage + 1} swipe ${direction} action`
        )
        for (const [id, label] of Object.entries(SWIPE_ACTION_LABELS)) {
          const option = document.createElement("option")
          option.value = id
          option.textContent = label
          select.append(option)
        }
        row.append(select)
      }

      container.append(row)
    }
  }

  private swipeControl<T extends HTMLElement>(key: string): T {
    return requireElement<T>(`[data-swipe="${key}"]`, requireElement("#swipe_stages"))
  }

  private apply_swipe_settings(settings: SwipeSettings): void {
    requireElement<HTMLInputElement>("#swipe_two_stage").checked =
      settings.twoStage
    for (const stage of [0, 1] as const) {
      this.swipeControl<HTMLInputElement>(`threshold-${stage}`).value =
        String(settings.stages[stage].threshold)
      this.swipeControl<HTMLInputElement>(`offset-${stage}`).value =
        String(settings.stages[stage].offset)
      this.swipeControl<HTMLSelectElement>(`right-${stage}`).value =
        settings.right[stage]
      this.swipeControl<HTMLSelectElement>(`left-${stage}`).value =
        settings.left[stage]
    }
    this.update_swipe_disabled_state()
  }

  /** Stage 2 controls are inert while the gesture is single-stage. */
  private update_swipe_disabled_state(): void {
    const twoStage = requireElement<HTMLInputElement>("#swipe_two_stage").checked
    const row = requireElement<HTMLElement>(
      '.swipe_row[data-stage="2"]',
      requireElement("#swipe_stages")
    )
    row.classList.toggle("disabled", !twoStage)
    row
      .querySelectorAll<HTMLInputElement | HTMLSelectElement>("input, select")
      .forEach((control) => {
        control.disabled = !twoStage
      })
  }

  private read_swipe_settings(): SwipeSettings {
    const number = (key: string, fallback: number): number => {
      const parsed = Number.parseInt(
        this.swipeControl<HTMLInputElement>(key).value,
        10
      )
      return Number.isFinite(parsed) ? parsed : fallback
    }
    const action = (key: string): SwipeActionId =>
      this.swipeControl<HTMLSelectElement>(key).value as SwipeActionId

    // Values are re-validated by normalizeSwipeSettings before they are
    // stored, so out-of-order thresholds typed here cannot be persisted.
    return {
      twoStage: requireElement<HTMLInputElement>("#swipe_two_stage").checked,
      stages: [
        {
          threshold: number("threshold-0", DEFAULT_SWIPE_SETTINGS.stages[0].threshold),
          offset: number("offset-0", DEFAULT_SWIPE_SETTINGS.stages[0].offset)
        },
        {
          threshold: number("threshold-1", DEFAULT_SWIPE_SETTINGS.stages[1].threshold),
          offset: number("offset-1", DEFAULT_SWIPE_SETTINGS.stages[1].offset)
        }
      ],
      right: [action("right-0"), action("right-1")],
      left: [action("left-0"), action("left-1")]
    }
  }

  async restore_swipe_settings(): Promise<void> {
    this.apply_swipe_settings(await this.client.getSwipeSettings())
  }

  async save_swipe_settings(): Promise<void> {
    await this.client.setSwipeSettings(this.read_swipe_settings())
    // Reflect whatever normalization the app applied.
    await this.restore_swipe_settings()
  }

  async restore_cache_settings(): Promise<void> {
    const cache_time_input =
      requireElement<HTMLInputElement>("#cache_time_input")
    const cache_time = await this.client.getCacheTime()
    cache_time_input.value = cache_time.toString()
  }

  async save_cache_settings(): Promise<void> {
    const cache_time_input =
      requireElement<HTMLInputElement>("#cache_time_input")
    const cache_time = cache_time_input.value
    await this.client.setCacheTime(cache_time)
  }
}
