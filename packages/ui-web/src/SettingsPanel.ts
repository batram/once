import { OnceApp, OnceClient, ThemeName } from "@once/app"
import * as menu from "./menu"

export class SettingsPanel {
  static instance: SettingsPanel
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
      this.clearSourceErrors()
      errors.forEach((error) => {
        this.addSourceError(error.url, error.message, error.type)
      })
    })

    window
      .matchMedia("(prefers-color-scheme: dark)")
      .addEventListener("change", (e) => {
        console.debug("system theme change", e)
      })

    this.restore_theme_settings()

    const theme_select =
      document.querySelector<HTMLSelectElement>("#theme_select")
    theme_select.addEventListener("change", () => {
      this.save_theme(theme_select.value)
    })

    const anim_checkbox =
      document.querySelector<HTMLInputElement>("#anim_checkbox")
    this.restore_animation_settings()
    anim_checkbox.addEventListener("change", () => {
      this.save_animation(anim_checkbox.checked)
    })

    const couch_input = document.querySelector<HTMLInputElement>("#couch_input")
    const couch_container = couch_input.parentElement as HTMLElement
    const couch_highlights =
      couch_container.querySelector<HTMLElement>(".couch-highlights")
    const couch_toggle =
      couch_container.querySelector<HTMLButtonElement>("#couch_toggle")

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

    couch_container.parentElement
      .querySelector('input[value="save"]')
      .addEventListener("click", () => {
        this.save_couch_settings()
      })
    couch_container.parentElement
      .querySelector('input[value="cancel"]')
      .addEventListener("click", () => {
        this.reset_couch_settings().then(() => updateCouchHighlights())
      })

    this.set_sources_area()

    const sources_area =
      document.querySelector<HTMLInputElement>("#sources_area")
    const sources_block = sources_area.closest(".settings_block")
    sources_block
      .querySelector('input[value="save"]')
      .addEventListener("click", () => {
        this.save_sources_settings()
      })
    sources_block
      .querySelector('input[value="cancel"]')
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

    const highlights = document.querySelector<HTMLElement>(".highlights")

    const handleInput = () => {
      const text = sources_area.value
      highlights.innerHTML = ""

      const lines = text.split("\n")

      lines.forEach((line) => {
        let errorMessage: string | null = null
        let errorType: "warning" | "error" | null = null

        // Check both old failedSources and new sourceErrors
        for (const [url, message] of Object.entries(this.failedSources)) {
          if (!url) continue
          if (line.trim() === url.trim()) {
            errorMessage = message
            errorType = "error"
            break
          }
        }

        // Check new sourceErrors if not found in old ones
        if (!errorMessage) {
          for (const [url, error] of this.sourceErrors) {
            if (line.trim() === url.trim()) {
              errorMessage = error.message
              errorType = error.type
              break
            }
          }
        }

        const lineContainer = document.createElement("div")
        lineContainer.classList.add("line-mirrored")

        if (errorMessage) {
          lineContainer.classList.add("error-line")
          const icon = document.createElement("div")

          // Determine if this is a warning or error
          const isWarning =
            errorType === "warning" ||
            errorMessage.includes("No handler available for this source type")
          icon.classList.add("error-icon")
          icon.textContent = isWarning ? "⚠️" : "❗"
          icon.title = isWarning
            ? "Click for warning details"
            : "Click for error details"
          icon.style.pointerEvents = "auto"
          icon.style.cursor = "pointer"
          icon.onclick = () => {
            alert(
              `${
                isWarning ? "Warning" : "Error"
              } loading source:\n${errorMessage}`
            )
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

    const filter_area = document.querySelector<HTMLInputElement>("#filter_area")
    const filter_block = filter_area.closest(".settings_block")
    filter_block
      .querySelector('input[value="save"]')
      .addEventListener("click", () => {
        this.save_filter_settings()
      })
    filter_block
      .querySelector("input[value=cancel]")
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
      document.querySelector<HTMLInputElement>("#redirect_area")
    const redirect_block = redirect_area.closest(".settings_block")
    redirect_block
      .querySelector('input[value="save"]')
      .addEventListener("click", () => {
        this.save_redirect_settings()
      })
    redirect_block
      .querySelector("input[value=cancel]")
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
    const cache_time_input = document.querySelector<HTMLInputElement>("#cache_time_input")
    const cache_block = cache_time_input.closest(".settings_block")
    cache_block
      .querySelector("#cache_time_save")
      .addEventListener("click", () => {
        this.save_cache_settings()
      })
    cache_block
      .querySelector("#cache_time_cancel")
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
    const couch_input = document.querySelector<HTMLInputElement>("#couch_input")
    couch_input.value = await this.client.getSyncUrl()
    // Trigger password highlighting update using existing function
    couch_input.dispatchEvent(new Event("input"))
  }

  save_couch_settings(): void {
    const couch_input = document.querySelector<HTMLInputElement>("#couch_input")
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
      document.querySelector<HTMLSelectElement>("#theme_select")
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
      document.querySelector<HTMLInputElement>("#anim_checkbox")
    anim_checkbox.checked = checked
    this.set_animation(checked)
  }

  save_animation(checked: boolean): void {
    this.client.setAnimation(checked)
    const anim_checkbox =
      document.querySelector<HTMLInputElement>("#anim_checkbox")
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
      document.querySelector<HTMLTextAreaElement>("#sources_area")
    const story_sources = await this.client.getStorySources()
    sources_area.value = story_sources.join("\n")
    // Trigger input event to update highlights
    sources_area.dispatchEvent(new Event("input"))
  }

  async save_sources_settings(): Promise<void> {
    const sources_area =
      document.querySelector<HTMLTextAreaElement>("#sources_area")
    const story_sources = sources_area.value.split("\n").filter((x) => {
      return x.trim() != ""
    })

    this.client.saveStorySources(story_sources)
  }

  async set_filter_area(): Promise<void> {
    const filter_area = document.querySelector<HTMLInputElement>("#filter_area")
    const filter_list = await this.client.getFilterList()
    filter_area.value = filter_list.join("\n")
  }

  save_filter_settings(): void {
    const filter_area = document.querySelector<HTMLInputElement>("#filter_area")
    const filter_list = filter_area.value.split("\n").filter((x) => {
      return x.trim() != ""
    })
    this.client.saveFilterList(filter_list)
  }

  async set_redirect_area(): Promise<void> {
    const redirect_area =
      document.querySelector<HTMLInputElement>("#redirect_area")
    const redirect_list = await this.client.getRedirectList()
    redirect_area.value = OnceApp.presentRedirectList(redirect_list)
  }

  save_redirect_settings(): void {
    const redirect_area =
      document.querySelector<HTMLInputElement>("#redirect_area")
    const redirect_list = OnceApp.parseRedirectList(redirect_area.value)
    this.client.saveRedirectList(redirect_list)
  }

  failedSources: Record<string, string> = {}
  private sourceErrors: Map<
    string,
    { message: string; type: "warning" | "error" }
  > = new Map()

  // Simple methods to manage source errors
  addSourceError(
    url: string,
    message: string,
    type: "warning" | "error" = "error"
  ): void {
    this.sourceErrors.set(url, { message, type })
    this.updateSourcesDisplay()
  }

  removeSourceError(url: string): void {
    if (this.sourceErrors.delete(url)) {
      this.updateSourcesDisplay()
    }
  }

  clearSourceErrors(): void {
    if (this.sourceErrors.size > 0) {
      this.sourceErrors.clear()
      this.updateSourcesDisplay()
    }
  }

  hasError(url: string): boolean {
    return this.sourceErrors.has(url)
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

    const textarea = document.querySelector<HTMLTextAreaElement>(
      `#${textareaId}`
    )
    if (!textarea) {
      console.error(`SettingsPanel: ${textareaId} not found!`)
      return
    }

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
      textarea.focus()
      textarea.setSelectionRange(startIndex, startIndex + searchText.length)
      // blur/focus hack to attempt scroll to selection
      textarea.blur()
      textarea.focus()
    } else {
      console.warn(
        `SettingsPanel: could not find text in ${textareaId}`,
        searchText
      )
    }
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

  public highlight_sources(
    failedSources: Record<string, string>,
    shouldOpenPanel = true
  ): void {
    console.log("SettingsPanel: highlighting sources", failedSources)
    this.failedSources = failedSources

    // Always update the visual display, even if not opening panel
    const sources_area =
      document.querySelector<HTMLTextAreaElement>("#sources_area")
    if (sources_area) {
      // Trigger input event to update highlights
      sources_area.dispatchEvent(new Event("input"))
    }

    // Scroll to first error if opening panel
    if (shouldOpenPanel) {
      const urls = Object.keys(failedSources)
      if (urls.length > 0) {
        this.highlight_textarea_content(
          "sources_area",
          urls[0],
          shouldOpenPanel,
          true
        )
      }
    }
  }

  async restore_cache_settings(): Promise<void> {
    const cache_time_input = document.querySelector<HTMLInputElement>("#cache_time_input")
    const cache_time = await this.client.getCacheTime()
    cache_time_input.value = cache_time.toString()
  }

  async save_cache_settings(): Promise<void> {
    const cache_time_input = document.querySelector<HTMLInputElement>("#cache_time_input")
    const cache_time = cache_time_input.value
    await this.client.setCacheTime(cache_time)
  }
}
