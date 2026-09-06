const STORAGE_KEY = "once:story-buttons"
type Platform = "mobile" | "desktop"
const buttons = new Map<string, string>([
  ["read", "Skip / mark unread"], ["bookmark", "Bookmark"],
  ["filter", "Filter source"], ["purge", "Purge story (development)"],
  ["builtin/outline", "Open in reader"]
])
const listeners = new Set<() => void>()

export function registerStoryButton(id: string, label: string): () => void {
  buttons.set(id, label)
  for (const listener of listeners) listener()
  return () => { buttons.delete(id); for (const listener of listeners) listener() }
}

function preferences(): Record<string, Partial<Record<Platform, boolean>>> {
  try {
    const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}")
    return value && typeof value === "object" && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

function shown(id: string, platform: Platform): boolean {
  const value = preferences()[id]?.[platform]
  return typeof value === "boolean" ? value : platform === "desktop"
}

export function applyStoryButtonPreferences(row: HTMLElement): void {
  const platform = document.body.dataset.platform === "mobile" ? "mobile" : "desktop"
  for (const button of row.querySelectorAll<HTMLElement>(".button_group > :not(.menu_btn)")) {
    const id = button.dataset.storyElement ?? (
      button.classList.contains("read_btn") ? "read" :
        button.classList.contains("star_btn") ? "bookmark" :
          button.classList.contains("filter_btn") ? "filter" : "purge")
    button.hidden = !shown(id, platform)
  }
}

export function mountStoryButtonSettings(host: HTMLElement): void {
  const render = () => {
    host.replaceChildren()
    const heading = document.createElement("h4")
    heading.className = "settings_subheading"
    heading.textContent = "Story buttons"
    const hint = document.createElement("p")
    hint.className = "settings_group_hint"
    hint.textContent = "Choose which buttons appear on story rows. Actions remain available in the story context menu. Mobile and desktop choices are saved separately on this device."
    const reset = document.createElement("button")
    reset.type = "button"
    reset.className = "button"
    reset.textContent = "Restore default buttons"
    reset.addEventListener("click", () => {
      localStorage.setItem(STORAGE_KEY, "{}")
      document.querySelectorAll<HTMLElement>("story-item").forEach(applyStoryButtonPreferences)
      render()
    })
    host.append(heading, hint, reset)
    for (const platform of ["mobile", "desktop"] as const) {
      const group = document.createElement("fieldset")
      group.className = "settings_group"
      const legend = document.createElement("legend")
      legend.textContent = platform === "mobile" ? "Mobile buttons" : "Desktop buttons"
      group.append(legend)
      for (const [id, label] of buttons) {
        const field = document.createElement("div")
        field.className = "settings_row settings_row_inline"
        const input = document.createElement("input")
        input.type = "checkbox"
        input.className = "switch"
        input.id = `story-button-${platform}-${id}`
        input.checked = shown(id, platform)
        const name = document.createElement("label")
        name.className = "settings_row_name"
        name.htmlFor = input.id
        name.textContent = label
        input.addEventListener("change", () => {
          const values = preferences()
          values[id] = { ...values[id], [platform]: input.checked }
          localStorage.setItem(STORAGE_KEY, JSON.stringify(values))
          document.querySelectorAll<HTMLElement>("story-item").forEach(applyStoryButtonPreferences)
        })
        field.append(name, input)
        group.append(field)
      }
      host.append(group)
    }
  }
  listeners.add(render)
  render()
}
