import { SourceError } from "@once/app"
import { requireClosestElement, requireElement } from "../dom"

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
  const block = requireClosestElement<HTMLElement>(textarea, ".settings_block")
  requireElement<HTMLInputElement>('input[value="save"]', block)
    .addEventListener("click", () => void save())
  requireElement<HTMLInputElement>('input[value="cancel"]', block)
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
      const sourceError = sourceErrors().get(line.trim())
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
        icon.onclick = () => showSourceError(sourceError.url)
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

export function bindCacheControls(
  restore: () => void | Promise<void>,
  save: () => void | Promise<void>
): void {
  const input = requireElement<HTMLInputElement>("#cache_time_input")
  const block = requireClosestElement<HTMLElement>(input, ".settings_block")
  requireElement<HTMLInputElement>("#cache_time_save", block)
    .addEventListener("click", () => void save())
  requireElement<HTMLInputElement>("#cache_time_cancel", block)
    .addEventListener("click", () => void restore())
  input.addEventListener("keydown", (event) => {
    if (event.keyCode === 27) {
      void restore()
    } else if (event.key === "s" && event.ctrlKey) {
      void save()
    }
  })
}

export function bindThemeAnimationControls(
  saveTheme: (theme: string) => void,
  saveAnimation: (enabled: boolean) => void
): void {
  const theme = requireElement<HTMLSelectElement>("#theme_select")
  theme.addEventListener("change", () => saveTheme(theme.value))
  const animation = requireElement<HTMLInputElement>("#anim_checkbox")
  animation.addEventListener("change", () => saveAnimation(animation.checked))
}
