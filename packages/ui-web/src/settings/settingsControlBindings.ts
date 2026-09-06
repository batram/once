import { mountStoryButtonSettings } from "../story/storyButtonPreferences"
import { SourceError } from "@once/app"
import { requireClosestElement, requireElement } from "../dom"
import { SETTINGS_EDITOR_SCOPE } from "./settingsStatus"

interface TextSettingBinding {
  textareaId: string
  restore(): void | Promise<void>
  save(): void | Promise<void>
  escape?: () => void | Promise<void>
}

export function bindTextSetting({
  textareaId,
  restore,
  save,
  escape = restore
}: TextSettingBinding): void {
  const textarea = requireElement<HTMLTextAreaElement>(`#${textareaId}`)
  // A section with one editor puts its buttons in the block; a section that
  // holds several (Extensions) gives each editor its own `.settings_editor`,
  // which is then the nearest thing that owns exactly one Save and Cancel.
  const block = requireClosestElement<HTMLElement>(textarea, SETTINGS_EDITOR_SCOPE)
  requireElement<HTMLButtonElement>('button[data-action="save"]', block)
    .addEventListener("click", () => void save())
  requireElement<HTMLButtonElement>('button[data-action="cancel"]', block)
    .addEventListener("click", () => void restore())
  textarea.addEventListener("keydown", (event) => {
    if (event.keyCode === 27) {
      void escape()
    } else if (event.key === "s" && event.ctrlKey) {
      void save()
    }
  })
}

export function bindSourceTextarea(
  sourceErrors: () => ReadonlyMap<string, SourceError>,
  showSourceError: (source: string) => void
): void {
  const textarea = requireElement<HTMLTextAreaElement>("#sources_area")
  const highlights = requireElement<HTMLElement>(".highlights")
  const render = () => {
    highlights.textContent = ""
    for (const line of textarea.value.split("\n")) {
      let sourceId = ""
      try {
        const value = JSON.parse(line.trim().replace(/,$/, ""))
        if (typeof value?.id === "string") sourceId = value.id
      } catch { /* structural lines are not source rows */ }
      const sourceError = sourceErrors().get(sourceId)
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
        icon.classList.add("settings_highlight_icon")
        icon.onclick = () => showSourceError(sourceError.sourceId)
        lineContainer.append(icon)
        const mark = document.createElement("mark")
        mark.textContent = line || " "
        lineContainer.append(mark)
      } else {
        lineContainer.textContent = line || " "
      }
      highlights.append(lineContainer)
    }
  }
  textarea.addEventListener("input", render)
  textarea.addEventListener("scroll", () => {
    highlights.scrollTop = textarea.scrollTop
  })
  render()
}

/**
 * The default cache window saves the moment it changes, like every other
 * single-value control. Escape still restores the stored value, which is what
 * the cancel button used to be for.
 */
export function bindCacheControls(
  restore: () => void | Promise<void>,
  save: () => void | Promise<void>
): void {
  const input = requireElement<HTMLInputElement>("#cache_time_input")
  input.addEventListener("change", () => void save())
  input.addEventListener("keydown", (event) => {
    if (event.keyCode === 27) void restore()
  })
}

export function bindThemeAnimationControls(
  saveTheme: (theme: string) => void,
  saveAnimation: (enabled: boolean) => void
): void {
  mountStoryButtonSettings(requireElement<HTMLElement>("#story_button_settings"))
  const theme = requireElement<HTMLSelectElement>("#theme_select")
  theme.addEventListener("change", () => saveTheme(theme.value))
  const animation = requireElement<HTMLInputElement>("#anim_checkbox")
  animation.addEventListener("change", () => saveAnimation(animation.checked))
}
