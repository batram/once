import { OnceClient, SourceError, ThemeName } from "@once/app"
import { parseRedirectList, presentRedirectList } from "@once/core"
import { requireClosestElement, requireElement } from "./dom"
import * as menu from "./menu"
import { showConfirmDialog } from "./ConfirmDialog"

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
      }
    })
    client.subscribe("sourceErrorsChanged", ({ errors }) => {
      this.setSourceErrors(errors)
    })

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
            void showConfirmDialog({
              message: `${
                isWarning ? "Warning" : "Error"
              } loading source:\n${sourceError.message}`,
              cancelLabel: null,
              positionWithin: requireElement<HTMLElement>("#settings_panel")
            })
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
    this.client.setSyncUrl(couch_input.value).then(
      () => {
        // Trigger password highlighting update using existing input event listener
        couch_input.dispatchEvent(new Event("input"))
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
