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

export function positionStoryButtons(row: HTMLElement): void {
  const group = row.querySelector(".button_group")
  const tags = Array.from(row.querySelectorAll(".substories > .info .tags_container")).pop()
  const target = document.body.dataset.platform === "mobile" && tags ? tags : row
  if (group && target === tags && !tags.querySelector(".story_tag_labels")) {
    const labels = document.createElement("div")
    labels.className = "story_tag_labels"
    for (const tag of Array.from(tags.children)) if (tag !== group) labels.appendChild(tag)
    tags.prepend(labels)
  }
  if (group && group.parentElement !== target) target.appendChild(group)
}

export function applyStoryButtonPreferences(row: HTMLElement): void {
  positionStoryButtons(row)
  const platform = document.body.dataset.platform === "mobile" ? "mobile" : "desktop"
  for (const button of row.querySelectorAll<HTMLElement>(".button_group > :not(.menu_btn)")) {
    const id = button.dataset.storyElement ?? (
      button.classList.contains("read_btn") ? "read" :
        button.classList.contains("star_btn") ? "bookmark" :
          button.classList.contains("filter_btn") ? "filter" : "purge")
    button.hidden = !shown(id, platform)
  }
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K, className: string, text: string
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag)
  node.className = className
  node.textContent = text
  return node
}

/**
 * One run of switches for the platform the app is running on. The other
 * platform's choices stay in storage untouched: a phone has no way to see a
 * desktop button, so it gets no say over one either.
 */
export function mountStoryButtonSettings(host: HTMLElement): void {
  const render = () => {
    const platform: Platform = document.body.dataset.platform === "mobile" ? "mobile" : "desktop"
    host.replaceChildren(
      element("h4", "settings_subheading", "Story buttons"),
      element("p", "settings_rows_hint",
        "Choose which buttons appear on story rows. Every action stays available in the story menu. Saved on this device.")
    )
    for (const [id, label] of buttons) {
      const field = element("div", "settings_row settings_row_inline", "")
      const input = document.createElement("input")
      input.type = "checkbox"
      input.className = "switch"
      input.id = `story-button-${platform}-${id}`
      input.checked = shown(id, platform)
      const name = element("label", "settings_row_name", label)
      name.htmlFor = input.id
      input.addEventListener("change", () => {
        const values = preferences()
        values[id] = { ...values[id], [platform]: input.checked }
        localStorage.setItem(STORAGE_KEY, JSON.stringify(values))
        document.querySelectorAll<HTMLElement>("story-item").forEach(applyStoryButtonPreferences)
      })
      field.append(name, input)
      host.append(field)
    }
    const reset = element("div", "settings_row settings_row_inline", "")
    const button = element("button", "button", "Restore")
    button.type = "button"
    button.addEventListener("click", () => {
      localStorage.setItem(STORAGE_KEY, "{}")
      document.querySelectorAll<HTMLElement>("story-item").forEach(applyStoryButtonPreferences)
      render()
    })
    reset.append(
      element("span", "settings_row_name", "Default buttons"),
      element("p", "settings_row_hint", "Puts back the standard set for this device."),
      button
    )
    host.append(reset)
  }
  listeners.add(render)
  render()
}
